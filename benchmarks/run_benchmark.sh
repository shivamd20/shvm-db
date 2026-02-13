#!/bin/bash
set -e

# Configuration
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

YCSB_DIR="./ycsb-dist"
WORKLOAD_DIR="./workloads"
BASE_RESULT_DIR="./results"
PUBLIC_DIR="../public"
DB_BINDING="dynamodb"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
ENDPOINT="http://localhost:8787/api"
OPERATION="run"

# Default to running all variants if no workloads specified
WORKLOADS="variant_a,variant_b,variant_c"

# Parse arguments
while [[ $# -gt 0 ]]; do
    key="$1"
    case $key in
        -w|--workloads)
            WORKLOADS="$2"
            shift # past argument
            shift # past value
            ;;
        -o|--operation)
            OPERATION="$2"
            shift # past argument
            shift # past value
            ;;
        -e|--endpoint)
            ENDPOINT="$2"
            shift # past argument
            shift # past value
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [-w variant_a,variant_b] [-o load|run] [-e http://localhost:8787/api]"
            exit 1
            ;;
    esac
done

# Ensure directories exist
mkdir -p "$BASE_RESULT_DIR"
mkdir -p "$PUBLIC_DIR/benchmarks"

# Create specific run directory
RUN_DIR="$BASE_RESULT_DIR/run_$TIMESTAMP"
mkdir -p "$RUN_DIR"

echo "=================================================="
echo "Starting Benchmark Run at $TIMESTAMP"
echo "Workloads: $WORKLOADS"
echo "Endpoint: $ENDPOINT"
echo "Output ID: $TIMESTAMP"
echo "=================================================="

# Process workloads
IFS=',' read -ra ADDR <<< "$WORKLOADS"
for workload in "${ADDR[@]}"; do
    workload=$(echo "$workload" | xargs) # trim
    WORKLOAD_PATH="$WORKLOAD_DIR/$workload"
    
    if [ ! -f "$WORKLOAD_PATH" ]; then
        echo "Error: Workload file '$workload' not found in $WORKLOAD_DIR"
        continue
    fi
    
    # 1. Load Phase (Always load before run for consistency in THIS script? 
    # Or should we assume data is loaded? 
    # The prompt implies "Running" benchmarks. 
    # YCSB usually requires a Load phase.
    # We will do LOAD then RUN for each to ensure clean state if possible, 
    # or just run if data is expected. 
    # Re-reading prompt: "Update benchmarks to always pick the latest run...". 
    # Variants have different record counts. So we MUST load.
    
    echo "--- Processing $workload ---"
    
    # Clean/Recreate table if supported (Optional, but good for repeatable benchmarks)
    # For now, we assume the user handles table lifecycle or we do it here. 
    # We'll just run LOAD then RUN.
    
    echo "Loading data for $workload..."
    "$YCSB_DIR/bin/ycsb.sh" load $DB_BINDING \
        -P "$WORKLOAD_PATH" \
        -p dynamodb.endpoint="$ENDPOINT" \
        -p dynamodb.primaryKey=PK \
        -p dynamodb.primaryKeyType=HASH \
        -p dynamodb.awsCredentialsFile="fake-aws-credentials.properties" \
        -s > "$RUN_DIR/load_${workload}_${TIMESTAMP}.txt" 2>&1
        
    echo "Running workload for $workload..."
    "$YCSB_DIR/bin/ycsb.sh" run $DB_BINDING \
        -P "$WORKLOAD_PATH" \
        -p dynamodb.endpoint="$ENDPOINT" \
        -p dynamodb.primaryKey=PK \
        -p dynamodb.primaryKeyType=HASH \
        -p dynamodb.awsCredentialsFile="fake-aws-credentials.properties" \
        -s > "$RUN_DIR/run_${workload}_${TIMESTAMP}.txt" 2>&1
        
    echo "Finished $workload"
done

echo "=================================================="
echo "Processing Results..."

# Run python script to process results and update public folder
python3 "$SCRIPT_DIR/process_results.py" "$RUN_DIR" "$PUBLIC_DIR" "$TIMESTAMP"

echo "Benchmark Complete!"
echo "View results at: $PUBLIC_DIR/benchmarks/index.json"
echo "=================================================="

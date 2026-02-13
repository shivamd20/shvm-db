#!/bin/bash
set -e

# Configuration
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
YCSB_DIR="$SCRIPT_DIR/ycsb-dist"
WORKLOAD_DIR="$SCRIPT_DIR/workloads"
BASE_RESULT_DIR="$SCRIPT_DIR/results"
DB_BINDING="dynamodb"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
ENDPOINT="http://localhost:8787/api"
OPERATION="run"
WORKLOADS=""

# Usage function
usage() {
    echo "Usage: $0 -w <workload_file1,workload_file2,...> [-o <load|run>] [-e <endpoint>]"
    echo "Example: $0 -w workloada_shvmdb,workloadb_shvmdb -o run"
    exit 1
}

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
            usage
            ;;
    esac
done

# Validate inputs
if [ -z "$WORKLOADS" ]; then
    echo "Error: Workloads must be supplied."
    usage
fi

# Ensure base directory exists
mkdir -p "$BASE_RESULT_DIR"

# Determine next run ID
last_run=$(find "$BASE_RESULT_DIR" -maxdepth 1 -type d -name "run_*" | sort | tail -n 1)
if [ -z "$last_run" ]; then
    run_num=1
else
    last_name=$(basename "$last_run")
    last_id=${last_name#run_}
    run_num=$((10#$last_id + 1))
fi
RUN_ID=$(printf "%04d" $run_num)
RESULT_DIR="$BASE_RESULT_DIR/run_$RUN_ID"

# Ensure run directory exists
mkdir -p "$RESULT_DIR"

echo "=================================================="
echo "Starting Benchmark Run $RUN_ID at $TIMESTAMP"
echo "Workloads: $WORKLOADS"
echo "Operation: $OPERATION"
echo "Endpoint: $ENDPOINT"
echo "=================================================="

# Process workloads
IFS=',' read -ra ADDR <<< "$WORKLOADS"
for workload in "${ADDR[@]}"; do
    # Trim whitespace just in case
    workload=$(echo "$workload" | xargs)
    
    # Resolve workload path
    if [ -f "$WORKLOAD_DIR/$workload" ]; then
        WORKLOAD_PATH="$WORKLOAD_DIR/$workload"
    elif [ -f "$workload" ]; then
        WORKLOAD_PATH="$workload"
    else
        echo "Error: Workload file '$workload' not found in $WORKLOAD_DIR or current directory."
        exit 1
    fi
    
    echo "Executing $OPERATION for workload: $workload"
    
    OUTPUT_FILE="$RESULT_DIR/${OPERATION}_${workload}_${TIMESTAMP}.txt"
    
    "$YCSB_DIR/bin/ycsb.sh" $OPERATION $DB_BINDING \
        -P "$WORKLOAD_PATH" \
        -p dynamodb.endpoint="$ENDPOINT" \
        -p dynamodb.primaryKey=PK \
        -p dynamodb.primaryKeyType=HASH \
        -p dynamodb.awsCredentialsFile="$SCRIPT_DIR/fake-aws-credentials.properties" \
        -s > "$OUTPUT_FILE" 2>&1

        
    echo "Done. Results: $OUTPUT_FILE"
done

echo "=================================================="
echo "Benchmark Complete!"
echo "Results stored in $RESULT_DIR"
echo "=================================================="

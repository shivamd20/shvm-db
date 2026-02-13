
import sys
import os
import json
import re
import datetime

def parse_ycsb_output(file_path):
    metrics = {}
    if not os.path.exists(file_path):
        return metrics
    
    with open(file_path, 'r') as f:
        for line in f:
            # Typical line: [OVERALL], RunTime(ms), 1005
            parts = line.strip().split(',')
            if len(parts) >= 3:
                group = parts[0].strip('[]')
                metric = parts[1].strip()
                value = parts[2].strip()
                
                if group not in metrics:
                    metrics[group] = {}
                
                try:
                    metrics[group][metric] = float(value)
                except ValueError:
                    metrics[group][metric] = value
                    
    return metrics

def parse_workload_file(file_path):
    config = {}
    if not os.path.exists(file_path):
        return config
        
    with open(file_path, 'r') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            if '=' in line:
                key, value = line.split('=', 1)
                config[key.strip()] = value.strip()
    return config

def main():
    if len(sys.argv) < 4:
        print("Usage: python process_results.py <run_dir> <public_dir> <timestamp>")
        sys.exit(1)

    run_dir = sys.argv[1]
    public_dir = sys.argv[2]
    timestamp = sys.argv[3]
    
    benchmarks_dir = os.path.join(public_dir, "benchmarks")
    run_output_dir = os.path.join(benchmarks_dir, timestamp)
    
    if not os.path.exists(run_output_dir):
        os.makedirs(run_output_dir)

    # Find all result files
    results = []
    
    for filename in os.listdir(run_dir):
        if filename.endswith(".txt") and "run" in filename:
            # Expected filename format: run_variant_a_TIMESTAMP.txt
            # Extract variant name
            parts = filename.split('_')
            # Assuming format: run_variant_a_... or run_workload_...
            # A bit loose, but let's try to capture the variant name.
            # actually run_benchmark.sh outputs: ${OPERATION}_${workload}_${TIMESTAMP}.txt
            # so run_variant_a_2023...txt
            
            variant = "unknown"
            if "variant_a" in filename: variant = "Hot Partition Stress"
            elif "variant_b" in filename: variant = "Sustained Mixed Load"
            elif "variant_c" in filename: variant = "Concurrency Scaling"
            elif "workload_dynamo_compat" in filename: variant = "DynamoDB Compatibility"
            else: variant = filename
            
            filepath = os.path.join(run_dir, filename)
            parsed_metrics = parse_ycsb_output(filepath)
            
            # Find corresponding workload file to get config
            workload_name = "variant_" + variant.split()[-1].lower()
            workload_file = os.path.join(os.path.dirname(run_dir), "../workloads", workload_name)
            # If simplistic matching fails, just check if we can find it
            if not os.path.exists(workload_file):
                 # Try to guess from filename
                 match = re.search(r'run_(variant_.*?)\d+', filename)
                 if match:
                     workload_file = os.path.join(os.path.dirname(run_dir), "../workloads", match.group(1).rstrip('_'))
            
            config = parse_workload_file(workload_file)
            
            results.append({
                "variant": variant,
                "metrics": parsed_metrics,
                "config": config,
                "raw_file": filename
            })
            
            # Copy raw file to public dir
            os.system(f"cp '{filepath}' '{run_output_dir}/{filename}'")

    # Save run details
    run_data = {
        "id": timestamp,
        "timestamp": timestamp, # Using timestamp as ID
        "results": results
    }
    
    with open(os.path.join(run_output_dir, "results.json"), 'w') as f:
        json.dump(run_data, f, indent=2)

    # Update index.json
    index_file = os.path.join(benchmarks_dir, "index.json")
    index_data = []
    if os.path.exists(index_file):
        try:
            with open(index_file, 'r') as f:
                index_data = json.load(f)
        except:
            pass
            
    # Add new run at the beginning
    summary = {
        "id": timestamp,
        "date": datetime.datetime.now().isoformat(),
        "variants": [r["variant"] for r in results]
    }
    index_data.insert(0, summary)
    
    with open(index_file, 'w') as f:
        json.dump(index_data, f, indent=2)

    print(f"Processed results for run {timestamp}")

if __name__ == "__main__":
    main()

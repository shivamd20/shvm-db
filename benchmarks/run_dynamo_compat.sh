SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Check for ycsb script in various locations or assume relative path
if [ -f "ycsb-dist/bin/ycsb.sh" ]; then
    YCSB_BIN="./ycsb-dist/bin/ycsb.sh"
else
    echo "YCSB binary not found in expected locations."
    exit 1
fi

WORKLOAD="workloads/workload_dynamo_compat"
ENDPOINT="http://localhost:8787/api"

echo "=========================================="
echo "Starting DynamoDB Compatibility Test"
echo "Endpoint: $ENDPOINT"
echo "Workload: $WORKLOAD"
echo "=========================================="

echo "[-1/3] Deleting 'usertable' if exists..."
curl -s -X POST $ENDPOINT/ \
  -H "x-amz-target: DynamoDB_20120810.DeleteTable" \
  -H "Content-Type: application/x-amz-json-1.0" \
  -d '{"TableName": "usertable"}'
sleep 2

echo "[0/3] Creating 'usertable' in shvm-db..."
curl -s -X POST $ENDPOINT/ \
  -H "x-amz-target: DynamoDB_20120810.CreateTable" \
  -H "Content-Type: application/x-amz-json-1.0" \
  -d '{
    "TableName": "usertable",
    "KeySchema": [{"AttributeName": "PK", "KeyType": "HASH"}],
    "AttributeDefinitions": [{"AttributeName": "PK", "AttributeType": "S"}],
    "ProvisionedThroughput": {"ReadCapacityUnits": 1, "WriteCapacityUnits": 1}
  }'
echo ""
echo "Table creation request sent."

# Sleep briefly to allow propagation (if any async)
sleep 2

# 1. Load Phase (Insert Data)
# Using -p dynamodb.debug=true to see errors if any
echo "[1/3] Loading data..."
"$YCSB_BIN" load dynamodb -P "$WORKLOAD" \
  -p dynamodb.endpoint="$ENDPOINT" \
  -p dynamodb.primaryKey=PK \
  -p dynamodb.primaryKeyType=HASH \
  -p dynamodb.awsCredentialsFile="fake-aws-credentials.properties" \
  -s 2>&1 | tee load_output.log

# Check if load failed
if grep -q "Return=ERROR" load_output.log; then
    echo "Load phase had errors. Checking log..."
    # tail -n 20 load_output.log
fi

# 2. Run Phase (Read/Update)
echo "[2/3] Running workload..."
"$YCSB_BIN" run dynamodb -P "$WORKLOAD" \
  -p dynamodb.endpoint="$ENDPOINT" \
  -p dynamodb.primaryKey=PK \
  -p dynamodb.primaryKeyType=HASH \
  -p dynamodb.awsCredentialsFile="fake-aws-credentials.properties" \
  -s 2>&1 | tee run_output.log

echo "=========================================="
echo "Test Complete!"
echo "=========================================="

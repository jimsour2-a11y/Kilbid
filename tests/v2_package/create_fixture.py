"""Create the one artificial A1 WORK_PACKAGE. Never reads v1 XLSX."""
from pathlib import Path
from dtcpkg import create_work_package, read_package
from test_dtcpkg import MANIFEST, PAYLOAD, DATASET

target = Path(__file__).with_name("TEST_A1_WORK_PACKAGE.dtcpkg")
if target.exists():
    raise SystemExit("fixture already exists; refusing overwrite")
data = create_work_package(MANIFEST, PAYLOAD)
target.write_bytes(data)
print(target.name, read_package(data, DATASET)[2])

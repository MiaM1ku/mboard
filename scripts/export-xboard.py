#!/usr/bin/env python3
"""Read a MySQL deployment into a private staged archive and SQL rollback snapshot."""
import argparse
import datetime
import gzip
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path


def read_env(path):
    values = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        values[key.strip()] = value
    if values.get("DB_CONNECTION", "mysql") != "mysql":
        raise ValueError("Source driver must be mysql")
    for key in ("DB_USERNAME", "DB_PASSWORD", "DB_DATABASE"):
        if not values.get(key):
            raise ValueError("Source connection needs " + key)
    return values


def options_file(directory, env, database=True):
    fd, path = tempfile.mkstemp(dir=directory, suffix=".cnf")
    os.fchmod(fd, 0o600)
    fields = [("host", env.get("DB_HOST", "127.0.0.1")), ("port", env.get("DB_PORT", "3306")),
              ("user", env["DB_USERNAME"]), ("password", env["DB_PASSWORD"]),
              ("default-character-set", "utf8mb4")]
    if database:
        fields.append(("database", env["DB_DATABASE"]))
    with os.fdopen(fd, "w") as handle:
        handle.write("[client]\n")
        for key, value in fields:
            handle.write(key + "=" + json.dumps(value) + "\n")
    return path


def export(env_path, destination):
    env = read_env(env_path)
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    if destination.stat().st_mode & 0o077:
        raise ValueError("Use a private output directory, mode 0700")
    root = destination / datetime.datetime.now(datetime.timezone.utc).strftime("migration-%Y%m%dT%H%M%SZ")
    root.mkdir(mode=0o700)
    saved_env = root / "source.env"
    saved_env.write_bytes(env_path.read_bytes())
    os.chmod(saved_env, 0o600)
    client = options_file(root, env)
    dump_options = None
    try:
        command = ["mysql", "--defaults-extra-file=" + client, "--batch", "--raw", "--skip-column-names"]

        def query(sql):
            result = subprocess.run(command + ["-e", sql], capture_output=True, text=True)
            if result.returncode:
                raise RuntimeError("Source metadata query needs attention (exit %d)" % result.returncode)
            return result.stdout.strip()

        tables = query("SHOW TABLES").splitlines()
        statements = []
        for table in tables:
            if not re.fullmatch(r"[A-Za-z0-9_]+", table):
                raise ValueError("Unexpected source table identifier")
            fields = []
            for line in query("SHOW COLUMNS FROM `" + table + "`").splitlines():
                name, kind = line.split("\t")[:2]
                if not re.fullmatch(r"[A-Za-z0-9_]+", name):
                    raise ValueError("Unexpected source column identifier")
                expression = "`" + name + "`"
                # Numeric strings preserve bigint/decimal precision in the offline archive.
                if re.match(r"^(tinyint|smallint|mediumint|int|bigint|decimal|float|double)", kind):
                    expression = "CAST(" + expression + " AS CHAR)"
                fields.extend(["'" + name + "'", expression])
            statements.append("SELECT 'MB_TABLE_" + table + "';\nSELECT JSON_OBJECT(" + ",".join(fields) + ") FROM `" + table + "`;\n")
        sql = "SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ; START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY;\n" + "".join(statements) + "COMMIT;"
        archive = root / "archive.json"
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        process.stdin.write(sql)
        process.stdin.close()
        counts = {}
        fd = os.open(archive, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as handle:
            handle.write('{"format":"mboard-staged-import-v1","tables":{')
            current, first_table, first_row = None, True, True
            for raw in process.stdout:
                line = raw.rstrip("\n")
                if line.startswith("MB_TABLE_"):
                    if current is not None:
                        handle.write("]")
                    current = line[9:]
                    counts[current] = 0
                    if not first_table:
                        handle.write(",")
                    handle.write(json.dumps(current) + ":[")
                    first_table, first_row = False, True
                elif line:
                    if current is None:
                        raise RuntimeError("Unexpected archive stream")
                    json.loads(line)
                    if not first_row:
                        handle.write(",")
                    handle.write(line)
                    first_row = False
                    counts[current] += 1
            if current is not None:
                handle.write("]")
            handle.write("}}")
            handle.flush()
            os.fsync(handle.fileno())
        if process.wait():
            raise RuntimeError("Consistent archive export needs attention")
        # mysqldump accepts its database as a positional argument, not a client option.
        dump_options = options_file(root, env, database=False)
        dump = root / "mysql-complete.sql.gz"
        process = subprocess.Popen(["mysqldump", "--defaults-extra-file=" + dump_options,
                                    "--single-transaction", "--quick", "--skip-lock-tables",
                                    "--no-tablespaces", "--set-gtid-purged=OFF", "--column-statistics=0",
                                    env["DB_DATABASE"]], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        with gzip.open(dump, "wb") as handle:
            shutil.copyfileobj(process.stdout, handle)
        os.chmod(dump, 0o600)
        if process.wait():
            raise RuntimeError("SQL backup needs attention; inspect the private source environment")
        summary = {"backup_directory": str(root), "archive_bytes": archive.stat().st_size,
                   "sql_backup_bytes": dump.stat().st_size, "tables_archived": len(counts),
                   "total_rows": sum(counts.values()),
                   "users": counts.get("v2_user", 0), "nodes": counts.get("v2_server", 0),
                   "machines": counts.get("v2_server_machine", 0), "groups": counts.get("v2_server_group", 0)}
        inventory = root / "inventory.json"
        inventory.write_text(json.dumps(summary, indent=2))
        os.chmod(inventory, 0o600)
        print(json.dumps(summary))
    finally:
        for path in (client, dump_options):
            if path:
                os.unlink(path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    try:
        export(args.env, args.output_dir)
    except Exception as error:
        # Values and client diagnostics stay private; stdout contains inventory only.
        raise SystemExit(str(error))

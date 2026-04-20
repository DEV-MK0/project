import asyncio
import random
import sqlite3
import time
import threading
import json
import csv
import os
import shutil
import socket
from math import log10, ceil
from datetime import datetime
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Body, Query
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from io import StringIO

START_TIME = time.time()
PROGRAM_START_TS = int(START_TIME)

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

SCHALTmin = 5.0
HYSTERESE = 1.0
TEMP1_min = 10.0
TEMP2_min = -10.0
DB_FILE = "measurements.db"
STATE_FILE = "state.json"

interval = 2
logging_thread = None


# -------------------- State Handling --------------------

def load_state():
    try:
        with open(STATE_FILE, "r") as f:
            return json.load(f)
    except Exception:
       return {
            "logging": False,
            "theme": "light",
            "interval": 2,
            "pointLimit": 10,
            "collapsedCards": {},
            "cardOrder": [],
            "editMode": False,
            "dbLimitValue": 20,
            "dbLimitUnit": "KB",
            "schedule": {
                "enabled": False,
                "startTime": "17:00",
                "endTime": "00:00",
                "action": "ON",
                "days": ["MO", "TU", "WE", "TH", "FR"]
            }
}

def _save_state():
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def state_get(key, default=None):
    return state.get(key, default)


def state_set(key, value):
    state[key] = value
    _save_state()


# -------------------- Core Logic --------------------


def round_up_to_multiple_of_4(value):
    value = float(value)
    return max(4, int(ceil(value / 4.0) * 4))


def taupunkt(t, r):
    a, b = (7.5, 237.3) if t >= 0 else (7.6, 240.7)

    sdd = 6.1078 * (10 ** ((a * t) / (b + t)))
    dd = sdd * (r / 100)
    v = log10(dd / 6.1078)

    return (b * v) / (a - v)


def measure_sensor():
    return (
        round(random.uniform(15, 25), 1),
        round(random.uniform(30, 60), 1),
        round(random.uniform(-5, 20), 1),
        round(random.uniform(20, 70), 1),
    )


def compute_measurement():
    t1, h1, t2, h2 = measure_sensor()
    runtime_seconds = int(time.time() - START_TIME)

    tp1 = taupunkt(t1, h1)
    tp2 = taupunkt(t2, h2)
    delta_tp = tp1 - tp2

    relay_on = (
        delta_tp > (SCHALTmin + HYSTERESE)
        and t1 >= TEMP1_min
        and t2 >= TEMP2_min
    )

    return {
        "t1": t1,
        "h1": h1,
        "t2": t2,
        "h2": h2,
        "tp1": round(tp1, 1),
        "tp2": round(tp2, 1),
        "delta_tp": round(delta_tp, 1),
        "relay": "ON" if relay_on else "OFF",
        "runtime_seconds": runtime_seconds,
        "program_start_ts": PROGRAM_START_TS
    }


# -------------------- Database --------------------

def init_db():
    with sqlite3.connect(DB_FILE) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS measurements (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                t1 REAL,
                h1 REAL,
                t2 REAL,
                h2 REAL,
                tp1 REAL,
                tp2 REAL,
                delta_tp REAL,
                relay TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)

def save_measurement(data):
    if enforce_db_limit():
        return False

    with sqlite3.connect(DB_FILE) as conn:
        conn.execute("""
            INSERT INTO measurements (t1,h1,t2,h2,tp1,tp2,delta_tp,relay)
            VALUES (?,?,?,?,?,?,?,?)
        """, (
            data["t1"], data["h1"], data["t2"], data["h2"],
            data["tp1"], data["tp2"], data["delta_tp"], data["relay"]
        ))

    enforce_db_limit()
    return True


def save_measurement_once():
    data = compute_measurement()
    return save_measurement(data)

def get_db_size_bytes():
    try:
        return os.path.getsize(DB_FILE)
    except OSError:
        return 0


def unit_to_bytes(value, unit):
    unit = (unit or "KB").upper()
    factors = {
        "KB": 1024,
        "MB": 1024 ** 2,
        "GB": 1024 ** 3,
        "TB": 1024 ** 4
    }
    return int(float(value) * factors.get(unit, 1024 ** 2))


def get_db_limit_bytes():
    value = state_get("dbLimitValue", 20)
    unit = state_get("dbLimitUnit", "KB")
    return unit_to_bytes(value, unit)


def enforce_db_limit():
    if get_db_size_bytes() >= get_db_limit_bytes():
        state_set("logging", False)
        return True
    return False

def get_db_status():
    size_bytes = get_db_size_bytes()
    limit_bytes = get_db_limit_bytes()
    used_percent = 0 if limit_bytes <= 0 else min((size_bytes / limit_bytes) * 100, 100)

    return {
        "dbSizeBytes": size_bytes,
        "dbLimitBytes": limit_bytes,
        "dbLimitValue": state_get("dbLimitValue", 20),
        "dbLimitUnit": state_get("dbLimitUnit", "KB"),
        "usedPercent": round(used_percent, 1),
        "loggingStoppedByLimit": size_bytes >= limit_bytes
    }

# -------------------- Logging Thread --------------------

def logging_loop():
    while state_get("logging"):
        try:
            if measuring_allowed_now():
                stored = save_measurement_once()
                if not stored:
                    break

            time.sleep(interval)
        except Exception as e:
            print("Logging error:", e)

# -------------------- System Overview --------------------

def get_default_schedule():
    return {
        "enabled": False,
        "startTime": "17:00",
        "endTime": "00:00",
        "action": "ON",
        "days": ["MO", "TU", "WE", "TH", "FR"]
    }


def get_schedule():
    schedule = state_get("schedule", {})
    default = get_default_schedule()

    merged = {
        "enabled": bool(schedule.get("enabled", default["enabled"])),
        "startTime": str(schedule.get("startTime", default["startTime"])),
        "endTime": str(schedule.get("endTime", default["endTime"])),
        "action": str(schedule.get("action", default["action"])).upper(),
        "days": list(schedule.get("days", default["days"]))
    }

    if merged["action"] not in ["ON", "OFF"]:
        merged["action"] = "ON"

    valid_days = {"MO", "TU", "WE", "TH", "FR", "SA", "SU"}
    merged["days"] = [d for d in merged["days"] if d in valid_days]

    return merged


def parse_time_to_minutes(value: str):
    try:
        hour, minute = value.split(":")
        hour = int(hour)
        minute = int(minute)

        if not (0 <= hour <= 23 and 0 <= minute <= 59):
            return None

        return hour * 60 + minute
    except Exception:
        return None


def schedule_window_active_now(schedule):
    if not schedule.get("enabled", False):
        return True

    day_map = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]
    now = datetime.now()
    weekday_code = day_map[now.weekday()]

    if weekday_code not in schedule.get("days", []):
        return False

    start_minutes = parse_time_to_minutes(schedule.get("startTime", "00:00"))
    end_minutes = parse_time_to_minutes(schedule.get("endTime", "00:00"))

    if start_minutes is None or end_minutes is None:
        return False

    now_minutes = now.hour * 60 + now.minute

    if start_minutes == end_minutes:
        return True

    if start_minutes < end_minutes:
        return start_minutes <= now_minutes < end_minutes

    return now_minutes >= start_minutes or now_minutes < end_minutes


def measuring_allowed_now():
    schedule = get_schedule()

    if not schedule["enabled"]:
        return True

    active = schedule_window_active_now(schedule)

    if schedule["action"] == "ON":
        return active

    return not active

_prev_cpu_total = None
_prev_cpu_idle = None

def get_cpu_frequency_ghz():
    try:
        with open("/proc/cpuinfo", "r") as f:
            for line in f:
                if "cpu MHz" in line:
                    mhz = float(line.split(":", 1)[1].strip())
                    return round(mhz / 1000.0, 2)
    except Exception:
        pass
    return None

def get_cpu_percent():
    global _prev_cpu_total, _prev_cpu_idle

    try:
        with open("/proc/stat", "r") as f:
            parts = f.readline().split()

        values = list(map(int, parts[1:]))
        idle = values[3] + values[4]
        total = sum(values)

        if _prev_cpu_total is None or _prev_cpu_idle is None:
            _prev_cpu_total = total
            _prev_cpu_idle = idle
            return 0.0

        total_diff = total - _prev_cpu_total
        idle_diff = idle - _prev_cpu_idle

        _prev_cpu_total = total
        _prev_cpu_idle = idle

        if total_diff <= 0:
            return 0.0

        usage = 100.0 * (1.0 - (idle_diff / total_diff))
        return round(max(0.0, min(usage, 100.0)), 1)

    except Exception:
        return 0.0


def get_memory_info():
    try:
        mem = {}
        with open("/proc/meminfo", "r") as f:
            for line in f:
                key, value = line.split(":", 1)
                mem[key] = int(value.strip().split()[0]) * 1024

        total = mem.get("MemTotal", 0)
        available = mem.get("MemAvailable", 0)
        used = max(total - available, 0)
        percent = round((used / total) * 100, 1) if total > 0 else 0.0

        return {
            "total": total,
            "used": used,
            "available": available,
            "percent": percent
        }
    except Exception:
        return {
            "total": 0,
            "used": 0,
            "available": 0,
            "percent": 0.0
        }


def get_disk_info():
    try:
        usage = shutil.disk_usage("/")
        percent = round((usage.used / usage.total) * 100, 1) if usage.total > 0 else 0.0

        return {
            "total": usage.total,
            "used": usage.used,
            "free": usage.free,
            "percent": percent
        }
    except Exception:
        return {
            "total": 0,
            "used": 0,
            "free": 0,
            "percent": 0.0
        }

# -------------------- API --------------------

@app.get("/")
async def get_index(request: Request):
    return templates.TemplateResponse("index.html", {
        "request": request,
        "initial_state": state
    })

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    message_count = 0

    try:
        while True:
            if measuring_allowed_now():
                data = compute_measurement()
            else:
                data = {
                    "t1": "-",
                    "h1": "-",
                    "t2": "-",
                    "h2": "-",
                    "tp1": "-",
                    "tp2": "-",
                    "delta_tp": "-",
                    "relay": "OFF",
                    "runtime_seconds": int(time.time() - START_TIME),
                    "program_start_ts": PROGRAM_START_TS,
                    "scheduleBlocked": True
                }

            message_count += 1

            if message_count == 1 or message_count % 5 == 0:
                data["systemOverview"] = {
                    "cpuPercent": get_cpu_percent(),
                    "cpuFrequencyGHz": get_cpu_frequency_ghz(),
                    "memory": get_memory_info(),
                    "disk": get_disk_info()
                }
                data["storageStatus"] = get_db_status()

            await websocket.send_json(data)
            await asyncio.sleep(interval)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"WebSocket error: {e}")

class SQLCommand(BaseModel):
    query: str


@app.post("/sql")
def execute_sql(command: SQLCommand):
    with sqlite3.connect(DB_FILE) as conn:
        cur = conn.cursor()

        try:
            cur.execute(command.query)

            if command.query.strip().lower().startswith("select"):
                rows = cur.fetchall()
                columns = [desc[0] for desc in cur.description]

                return {
                    "type": "table",
                    "columns": columns,
                    "rows": rows
                }

            return {"type": "text", "data": {"status": "ok"}}

        except Exception as e:
            return {"type": "text", "data": {"error": str(e)}}


@app.post("/measurements/start")
async def start_measurements(count: int = Body(..., embed=True)):
    for _ in range(count):
        save_measurement_once()
    return {"stored": count}


@app.get("/set_logging")
def set_logging(enabled: bool):
    global logging_thread

    if enabled and enforce_db_limit():
        return state

    state_set("logging", enabled)

    if enabled:
        if logging_thread is None or not logging_thread.is_alive():
            logging_thread = threading.Thread(target=logging_loop, daemon=True)
            logging_thread.start()

    return state

@app.get("/storage_status")
def get_storage_status():
    return get_db_status()


@app.get("/set_db_limit")
def set_db_limit(value: float, unit: str):
    unit = unit.upper()

    if unit not in ["KB", "MB", "GB", "TB"]:
        return {"error": "invalid unit"}

    if value <= 0:
        return {"error": "value must be greater than 0"}

    rounded_value = round_up_to_multiple_of_4(value)

    state_set("dbLimitValue", rounded_value)
    state_set("dbLimitUnit", unit)
    enforce_db_limit()

    status = get_storage_status()
    status["roundedInputValue"] = rounded_value
    return status

@app.get("/get_schedule")
def get_schedule_endpoint():
    schedule = get_schedule()
    schedule["measuringAllowedNow"] = measuring_allowed_now()
    return schedule


@app.post("/set_schedule")
def set_schedule(data: dict = Body(...)):
    enabled = bool(data.get("enabled", False))
    start_time = str(data.get("startTime", "17:00"))
    end_time = str(data.get("endTime", "00:00"))
    action = str(data.get("action", "ON")).upper()
    days = data.get("days", [])

    if parse_time_to_minutes(start_time) is None:
        return {"error": "invalid startTime"}

    if parse_time_to_minutes(end_time) is None:
        return {"error": "invalid endTime"}

    if action not in ["ON", "OFF"]:
        return {"error": "invalid action"}

    valid_days = {"MO", "TU", "WE", "TH", "FR", "SA", "SU"}
    days = [d for d in days if d in valid_days]

    schedule = {
        "enabled": enabled,
        "startTime": start_time,
        "endTime": end_time,
        "action": action,
        "days": days
    }

    state_set("schedule", schedule)

    result = get_schedule()
    result["measuringAllowedNow"] = measuring_allowed_now()
    return result

@app.get("/save_measurements")
async def save_measurements_endpoint(count: int = Query(..., gt=0)):
    if not measuring_allowed_now():
        return {
            "status": "blocked_by_schedule",
            "saved": 0,
            "requested": count,
            "reason": "schedule_blocked",
            "storageStatus": get_db_status()
        }

    saved = 0

    for _ in range(count):
        if not measuring_allowed_now():
            return {
                "status": "blocked_by_schedule",
                "saved": saved,
                "requested": count,
                "reason": "schedule_blocked",
                "storageStatus": get_db_status()
            }

        stored = save_measurement_once()
        if not stored:
            return {
                "status": "stopped",
                "saved": saved,
                "requested": count,
                "reason": "db_limit_reached",
                "storageStatus": get_db_status()
            }

        saved += 1

        if saved < count:
            await asyncio.sleep(interval)

    return {
        "status": "ok",
        "saved": saved,
        "requested": count,
        "storageStatus": get_db_status()
    }

@app.delete("/measurements/reset")
def reset_measurements():
    with sqlite3.connect(DB_FILE) as conn:
        conn.execute("DELETE FROM measurements")
        conn.execute("DELETE FROM sqlite_sequence WHERE name='measurements'")
        conn.commit()

    with sqlite3.connect(DB_FILE) as conn:
        conn.execute("VACUUM")

    return {"status": "reset"}

@app.get("/measurements/history")
def measurement_history(limit: int = 10):
    with sqlite3.connect(DB_FILE) as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT substr(timestamp, 12, 8), t1, t2
            FROM measurements
            ORDER BY id DESC
            LIMIT ?
        """, (limit,))
        rows = cur.fetchall()

    return rows[::-1]


@app.get("/get_logging")
def get_logging():
    return state


@app.get("/get_theme")
def get_theme():
    return {"theme": state_get("theme", "light")}


@app.get("/set_theme")
def set_theme(theme: str):
    if theme not in ["light", "dark"]:
        return {"error": "invalid theme"}

    state_set("theme", theme)
    return {"theme": theme}


@app.get("/set_interval")
def set_interval(new_interval: int):
    global interval
    interval = int(new_interval)

    state_set("interval", interval)
    return {"status": "ok"}


@app.get("/get_interval")
def get_interval():
    return {"interval": state_get("interval", 2)}


@app.get("/get_point_limit")
def get_point_limit():
    return {"pointLimit": state_get("pointLimit", 10)}


@app.get("/set_point_limit")
def set_point_limit(limit: int):
    state_set("pointLimit", int(limit))
    return {"status": "ok"}

@app.get("/measurements/export")
def export_csv():
    conn = sqlite3.connect(DB_FILE)
    cur = conn.cursor()

    cur.execute("""
        SELECT id, t1, h1, t2, h2, tp1, tp2, delta_tp, relay, timestamp
        FROM measurements
        ORDER BY id ASC
    """)

    rows = cur.fetchall()
    headers = [desc[0] for desc in cur.description]

    conn.close()

    output = StringIO()
    writer = csv.writer(output)

    writer.writerow(headers)
    writer.writerows(rows)

    output.seek(0)

    return StreamingResponse(
        output,
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=measurements.csv"}
    )

@app.get("/get_collapsed_cards")
def get_collapsed_cards():
    return {"collapsedCards": state_get("collapsedCards", {})}


@app.post("/set_collapsed_cards")
def set_collapsed_cards(data: dict = Body(...)):
    state_set("collapsedCards", data)
    return {"status": "ok"}

@app.get("/system_overview")
def get_system_overview():
    memory = get_memory_info()
    disk = get_disk_info()

    return {
        "hostname": socket.gethostname(),
        "cpuPercent": get_cpu_percent(),
        "cpuFrequencyGHz": get_cpu_frequency_ghz(),
        "memory": memory,
        "disk": disk
    }

@app.get("/get_card_order")
def get_card_order():
    return {"cardOrder": state_get("cardOrder", [])}


@app.post("/set_card_order")
def set_card_order(order: list[str] = Body(...)):
    state_set("cardOrder", order)
    return {"status": "ok"}


@app.get("/get_edit_mode")
def get_edit_mode():
    return {"editMode": state_get("editMode", False)}


@app.get("/set_edit_mode")
def set_edit_mode(enabled: bool):
    state_set("editMode", enabled)
    return {"editMode": enabled}

# -------------------- Init --------------------

init_db()
state = load_state()
get_cpu_percent()

interval = state_get("interval", 2)

if state_get("logging"):
    logging_thread = threading.Thread(target=logging_loop, daemon=True)
    logging_thread.start()

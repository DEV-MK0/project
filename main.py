import asyncio
import random
import sqlite3
import time
import threading
import json
from math import log10, pow

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Body, Query
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

SCHALTmin = 5.0
HYSTERESE = 1.0
TEMP1_min = 10.0
TEMP2_min = -10.0
DB_FILE = "measurements.db"
logging_thread = None
STATE_FILE = "state.json"

@app.get("/")
async def get_index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


def taupunkt(t, r):
    if t >= 0:
        a, b = 7.5, 237.3
    else:
        a, b = 7.6, 240.7

    sdd = 6.1078 * pow(10, (a * t) / (b + t))
    dd = sdd * (r / 100)
    v = log10(dd / 6.1078)
    tt = (b * v) / (a - v)

    return tt


def measure_sensor():
    t1 = round(random.uniform(15, 25), 1)
    h1 = round(random.uniform(30, 60), 1)
    t2 = round(random.uniform(-5, 20), 1)
    h2 = round(random.uniform(20, 70), 1)

    return t1, h1, t2, h2


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()

    try:
        while True:
            t1, h1, t2, h2 = measure_sensor()

            tp1 = taupunkt(t1, h1)
            tp2 = taupunkt(t2, h2)
            delta_tp = tp1 - tp2

            rel = False

            if delta_tp > (SCHALTmin + HYSTERESE):
                rel = True
            if delta_tp < SCHALTmin:
                rel = False
            if t1 < TEMP1_min:
                rel = False
            if t2 < TEMP2_min:
                rel = False

            data = {
                "t1": t1,
                "h1": h1,
                "t2": t2,
                "h2": h2,
                "tp1": round(tp1, 1),
                "tp2": round(tp2, 1),
                "delta_tp": round(delta_tp, 1),
                "relay": "ON" if rel else "OFF"
            }

            try:
                await websocket.send_json(data)
            except WebSocketDisconnect:
                break

            await asyncio.sleep(2)

    except Exception as e:
        print(f"WebSocket error: {e}")


class SQLCommand(BaseModel):
    query: str


@app.post("/sql")
def execute_sql(command: SQLCommand):
    conn = sqlite3.connect(DB_FILE)
    cur = conn.cursor()

    try:
        cur.execute(command.query)

        if command.query.strip().lower().startswith("select"):
            rows = cur.fetchall()
            columns = [desc[0] for desc in cur.description]

            result = {
                "type": "table",
                "columns": columns,
                "rows": rows
            }
        else:
            conn.commit()
            result = {
                "type": "text",
                "data": {"status": "ok"}
            }

    except Exception as e:
        result = {
            "type": "text",
            "data": {"error": str(e)}
        }

    conn.close()
    return result


@app.post("/measurements/start")
async def start_measurements(count: int = Body(..., embed=True)):
    for _ in range(count):
        t1, h1, t2, h2 = measure_sensor()

        tp1 = taupunkt(t1, h1)
        tp2 = taupunkt(t2, h2)
        delta_tp = tp1 - tp2

        rel = False

        if delta_tp > (SCHALTmin + HYSTERESE):
            rel = True
        if delta_tp < SCHALTmin:
            rel = False
        if t1 < TEMP1_min:
            rel = False
        if t2 < TEMP2_min:
            rel = False

        data = {
            "t1": t1,
            "h1": h1,
            "t2": t2,
            "h2": h2,
            "tp1": round(tp1, 1),
            "tp2": round(tp2, 1),
            "delta_tp": round(delta_tp, 1),
            "relay": "ON" if rel else "OFF"
        }

        save_measurement(data)

    return {"stored": count}


def init_db():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()

    c.execute("""
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

    conn.commit()
    conn.close()


def save_measurement(data):
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()

    c.execute("""
        INSERT INTO measurements (t1,h1,t2,h2,tp1,tp2,delta_tp,relay)
        VALUES (?,?,?,?,?,?,?,?)
    """, (
        data["t1"],
        data["h1"],
        data["t2"],
        data["h2"],
        data["tp1"],
        data["tp2"],
        data["delta_tp"],
        data["relay"]
    ))

    conn.commit()
    conn.close()


async def save_measurements(count):
    for _ in range(count):
        t1, h1, t2, h2 = measure_sensor()

        tp1 = taupunkt(t1, h1)
        tp2 = taupunkt(t2, h2)
        delta_tp = tp1 - tp2

        rel = "OFF"

        if delta_tp > (SCHALTmin + HYSTERESE) and t1 >= TEMP1_min and t2 >= TEMP2_min:
            rel = "ON"

        data = {
            "t1": t1,
            "h1": h1,
            "t2": t2,
            "h2": h2,
            "tp1": round(tp1, 1),
            "tp2": round(tp2, 1),
            "delta_tp": round(delta_tp, 1),
            "relay": rel
        }

        save_measurement(data)
        await asyncio.sleep(2)


def logging_loop():

    while state["logging"]:
        try:
            asyncio.run(save_measurements(1))
        except Exception as e:
            print("Logging error:", e)

@app.get("/set_logging")
def set_logging(enabled: bool):
    global logging_thread

    state["logging"] = enabled
    save_state()

    if enabled:
        if logging_thread is None or not logging_thread.is_alive():
            logging_thread = threading.Thread(target=logging_loop, daemon=True)
            logging_thread.start()

    return state

@app.get("/save_measurements")
async def save_measurements_endpoint(count: int = Query(..., gt=0)):
    await save_measurements(count)
    return {"status": "ok", "saved": count}

@app.delete("/measurements/reset")
def reset_measurements():
    conn = sqlite3.connect(DB_FILE)
    cur = conn.cursor()

    cur.execute("DELETE FROM measurements")
    cur.execute("DELETE FROM sqlite_sequence WHERE name='measurements'")

    conn.commit()
    conn.close()

    return {"status": "reset"}

@app.post("/measurements/select")
async def select_measurments():
    command = SQLCommand(query="SELECT * FROM measurements")
    execute_sql(SQLCommand(command))

    return {"status": "select"}

@app.get("/measurements/history")
def measurement_history(limit: int = 10):
    conn = sqlite3.connect(DB_FILE)
    cur = conn.cursor()

    cur.execute("""
    SELECT substr(timestamp, 12, 8), t1, t2
    FROM measurements
    ORDER BY id DESC
    LIMIT ?
    """, (limit,))

    rows = cur.fetchall()
    conn.close()

    return rows[::-1]

init_db()

def load_state():
    try:
        with open(STATE_FILE, "r") as f:
            return json.load(f)
    except:
        return {
            "logging": False,
            "theme": "light"
        }


def save_state():
    with open(STATE_FILE, "w") as f:
        json.dump(state, f)

state = load_state()

if state["logging"]:
    logging_thread = threading.Thread(target=logging_loop, daemon=True)
    logging_thread.start()

@app.get("/get_logging")
def get_logging():
    return state

@app.get("/get_theme")
def get_theme():
    return {"theme": state.get("theme", "light")}


@app.get("/set_theme")
def set_theme(theme: str):
    if theme not in ["light", "dark"]:
        return {"error": "invalid theme"}

    state["theme"] = theme
    save_state()

    return {"theme": theme}

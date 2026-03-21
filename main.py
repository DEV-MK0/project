import asyncio
import random
from math import log10, pow
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from fastapi.requests import Request
from fastapi.staticfiles import StaticFiles
from fastapi import Body
from fastapi import Query
from pydantic import BaseModel
import sqlite3

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

SCHALTmin = 5.0
HYSTERESE = 1.0
TEMP1_min = 10.0
TEMP2_min = -10.0

@app.get("/")
async def get_index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

def taupunkt(t, r):
    if t >= 0:
        a, b = 7.5, 237.3
    else:
        a, b = 7.6, 240.7
    sdd = 6.1078 * pow(10, (a * t)/(b + t))
    dd = sdd * (r / 100)
    v = log10(dd / 6.1078)
    tt = (b * v) / (a - v)
    return tt

def measure_sensor():
    # simulate sensor values
    t1 = round(random.uniform(15, 25), 1)  # inside temp
    h1 = round(random.uniform(30, 60), 1)  # inside humidity
    t2 = round(random.uniform(-5, 20), 1)  # outside temp
    h2 = round(random.uniform(20, 70), 1)  # outside humidity
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
                "t1": t1, "h1": h1, "t2": t2, "h2": h2,
                "tp1": round(tp1, 1), "tp2": round(tp2, 1),
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
    conn = sqlite3.connect("measurements.db")
    cur = conn.cursor()

    try:
        cur.execute(command.query)

        if command.query.strip().lower().startswith("select"):
            result = cur.fetchall()
        else:
            conn.commit()
            result = {"status": "ok"}

    except Exception as e:
        result = {"error": str(e)}

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

DB_FILE = "measurements.db"

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
    """, (data["t1"], data["h1"], data["t2"], data["h2"],
          data["tp1"], data["tp2"], data["delta_tp"], data["relay"]))
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
            "t1": t1, "h1": h1, "t2": t2, "h2": h2,
            "tp1": round(tp1,1), "tp2": round(tp2,1),
            "delta_tp": round(delta_tp,1), "relay": rel
        }
        save_measurement(data)
        await asyncio.sleep(2)  # optional delay between measurements

init_db()

@app.get("/save_measurements")
async def save_measurements_endpoint(count: int = Query(..., gt=0)):
    await save_measurements(count)
    return {"status": "ok", "saved": count}

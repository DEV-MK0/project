import asyncio
import random
from math import log10, pow
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from fastapi.requests import Request

app = FastAPI()
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

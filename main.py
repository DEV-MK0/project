from fastapi import FastAPI, WebSocket, Request
from fastapi.templating import Jinja2Templates
import sqlite3
import asyncio
import uvicorn

app = FastAPI()
templates = Jinja2Templates(directory="templates")


def measure_temperature():
    # Replace this with your real sensor code
    import random
    return round(20 + random.random() * 10, 2)


def init_db():
    conn = sqlite3.connect("measurements.db")
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS measurements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            temperature REAL
        )
    """)
    conn.commit()
    conn.close()


init_db()


@app.get("/")
def home(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.post("/start")
def start_measurement():
    temp = measure_temperature()

    conn = sqlite3.connect("measurements.db")
    cursor = conn.cursor()
    cursor.execute("INSERT INTO measurements (temperature) VALUES (?)", (temp,))
    conn.commit()
    conn.close()

    return {"temperature": temp}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()

    while True:
        temp = measure_temperature()
        await websocket.send_json({"temperature": temp})
        await asyncio.sleep(2)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)

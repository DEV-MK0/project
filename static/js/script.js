let maxPoints = 10;
let chart;
let ws;

/* -------------------- Helpers -------------------- */

async function api(url, options = {}) {
    const res = await fetch(url, options);
    return res.json();
}

function createTable(columns, rows) {
    const table = document.createElement("table");

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");

    columns.forEach(col => {
        const th = document.createElement("th");
        th.textContent = col;
        headRow.appendChild(th);
    });

    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");

    rows.forEach(row => {
        const tr = document.createElement("tr");

        row.forEach(cell => {
            const td = document.createElement("td");
            td.textContent = cell;
            tr.appendChild(td);
        });

        tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    return table;
}

/* -------------------- Chart -------------------- */

function initChart() {
    const ctx = document.getElementById("liveChart").getContext("2d");

    chart = new Chart(ctx, {
        type: "line",
        data: {
            labels: [],
            datasets: [
                { label: "Inside Temp", data: [] },
                { label: "Outside Temp", data: [] }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false
        }
    });
}

function trimChartData() {
    while (chart.data.labels.length > maxPoints) {
        chart.data.labels.shift();
        chart.data.datasets[0].data.shift();
        chart.data.datasets[1].data.shift();
    }
}

async function loadHistory(limit = maxPoints) {
    maxPoints = limit;

    const rows = await api(`/measurements/history?limit=${limit}`);

    chart.data.labels = [];
    chart.data.datasets[0].data = [];
    chart.data.datasets[1].data = [];

    rows.forEach(([time, t1, t2]) => {
        chart.data.labels.push(time);
        chart.data.datasets[0].data.push(t1);
        chart.data.datasets[1].data.push(t2);
    });

    chart.update();
}

/* -------------------- WebSocket -------------------- */

function initWebSocket() {
    ws = new WebSocket(`ws://${location.host}/ws`);

    ws.onmessage = ({ data }) => {
        const d = JSON.parse(data);

        document.getElementById("t1").textContent = d.t1;
        document.getElementById("h1").textContent = d.h1;
        document.getElementById("tp1").textContent = d.tp1;

        document.getElementById("t2").textContent = d.t2;
        document.getElementById("h2").textContent = d.h2;
        document.getElementById("tp2").textContent = d.tp2;

        document.getElementById("delta_tp").textContent = d.delta_tp;
        document.getElementById("relay").textContent = d.relay;

        const now = new Date().toLocaleTimeString("de-DE");

        chart.data.labels.push(now);
        chart.data.datasets[0].data.push(d.t1);
        chart.data.datasets[1].data.push(d.t2);

        trimChartData();
        chart.update();
    };
}

/* -------------------- Measurements -------------------- */

async function startMeasurements() {
    const count = document.getElementById("measure_count").value;
    const duration = count * 2;

    document.getElementById("measureStatus").style.display = "none";

    startProgress(duration);
    await api(`/save_measurements?count=${count}`);
}

/* -------------------- SQL -------------------- */

async function runSQL(query) {
    const result = await api("/sql", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ query })
    });

    const tableContainer = document.getElementById("sqlTableContainer");
    const textOutput = document.getElementById("sqlResult");

    tableContainer.innerHTML = "";
    textOutput.textContent = "";

    if (result.type === "table") {
        tableContainer.appendChild(createTable(result.columns, result.rows));
    } else {
        textOutput.textContent = JSON.stringify(result.data, null, 2);
    }
}

function runSQLFromInput() {
    const query = document.getElementById("sqlInput").value;
    runSQL(query);
}

function selectTable() {
    runSQL("SELECT * FROM measurements");
}

async function resetTable() {
    if (!confirm("Reset table and counter?")) return;

    await fetch("/measurements/reset", { method: "DELETE" });
    await loadHistory(maxPoints);
}

/* -------------------- Logging -------------------- */

async function initLogging() {
    const data = await api("/get_logging");

    const toggle = document.getElementById("logToggle");
    const label = document.getElementById("logLabel");

    toggle.checked = data.logging;

    function update() {
        const enabled = toggle.checked;

        label.textContent = enabled
            ? "Logging enabled"
            : "Logging disabled";

        fetch(`/set_logging?enabled=${enabled}`);
    }

    toggle.addEventListener("change", update);
    update();
}

/* -------------------- Theme -------------------- */

function applyTheme(theme) {
    document.body.classList.toggle("dark", theme === "dark");
    document.getElementById("themeToggle").checked = theme === "dark";
}

async function initTheme() {
    const data = await api("/get_theme");
    applyTheme(data.theme);

    const toggle = document.getElementById("themeToggle");

    toggle.addEventListener("change", async () => {
        const theme = toggle.checked ? "dark" : "light";
        await fetch(`/set_theme?theme=${theme}`);
        applyTheme(theme);
    });
}

/* -------------------- Interval -------------------- */

async function initInterval() {
    const data = await api("/get_interval");
    document.getElementById("interval").value = data.interval ?? 2;
}

async function setinterval() {
    const value = document.getElementById("interval").value;
    await fetch(`/set_interval?new_interval=${value}`);
}

/* -------------------- Progress -------------------- */

function startProgress(duration) {
    const circle = document.querySelector(".progress-circle .progress");
    const status = document.getElementById("measureStatus");

    const radius = 16;
    const circumference = 2 * Math.PI * radius;

    circle.style.strokeDasharray = circumference;

    let start;

    function animate(ts) {
        if (!start) start = ts;

        const progress = Math.min((ts - start) / 1000 / duration, 1);
        circle.style.strokeDashoffset = circumference * (1 - progress);

        if (progress < 1) {
            requestAnimationFrame(animate);
        } else {
            status.style.display = "inline";
        }
    }

    requestAnimationFrame(animate);
}

/* -------------------- Limit ------------------- */

async function initPointLimit() {
    const data = await api("/get_point_limit");

    const select = document.getElementById("pointLimit");
    const value = data.pointLimit ?? 10;

    select.value = value;
    maxPoints = parseInt(value, 10);
}

/* -------------------- Init -------------------- */

document.addEventListener("DOMContentLoaded", async () => {
    initChart();
    initWebSocket();

    const pointLimit = document.getElementById("pointLimit");
    maxPoints = parseInt(pointLimit.value, 10);

    pointLimit.addEventListener("change", async (e) => {
        const value = parseInt(e.target.value, 10);

        maxPoints = value;
        await fetch(`/set_point_limit?limit=${value}`);

        loadHistory(value);
    });

    await initPointLimit();
    await loadHistory(maxPoints);

    await Promise.all([
        initLogging(),
        initTheme(),
        initInterval()
    ]);
});

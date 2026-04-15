let maxPoints = 10;
let relayChart;
let chart;
let ws;
let programStartTs = null;
let runtimeTimer = null;

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

function formatDuration(totalSeconds) {
    const h = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
    const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
    const s = String(totalSeconds % 60).padStart(2, "0");
    return `${h}:${m}:${s}`;
}

function updateRuntime() {
    if (!programStartTs) return;
    const now = Math.floor(Date.now() / 1000);
    const runtime = Math.max(0, now - programStartTs);
    const relayText = document.getElementById("relay").dataset.relayState || "-";
    document.getElementById("relay").textContent = `${relayText} (${formatDuration(runtime)})`;
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
            animation: {
                duration: 300,
                easing: "linear"
            },
            responsive: true,
            maintainAspectRatio: false
        }
    });
}

function trimChartData() {
    while (chart.data.labels.length > maxPoints) {
        chart.data.labels.shift();
        chart.data.datasets.forEach(ds => ds.data.shift());
    }

    while (relayChart.data.labels.length > maxPoints) {
        relayChart.data.labels.shift();
        relayChart.data.datasets[0].data.shift();
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

    ws.onmessage = function(event) {
        const data = JSON.parse(event.data);

        if (data.program_start_ts) {
            programStartTs = data.program_start_ts;
        }

        if (!runtimeTimer && programStartTs) {
            runtimeTimer = setInterval(updateRuntime, 1000);
        }

        const runtime = formatDuration(data.runtime_seconds);

        document.getElementById("t1").textContent = data.t1;
        document.getElementById("h1").textContent = data.h1;
        document.getElementById("tp1").textContent = data.tp1;

        document.getElementById("t2").textContent = data.t2;
        document.getElementById("h2").textContent = data.h2;
        document.getElementById("tp2").textContent = data.tp2;

        document.getElementById("delta_tp").textContent = data.delta_tp;
        document.getElementById("relay").dataset.relayState = data.relay;
        updateRuntime();
        document.getElementById("runtime").textContent = runtime;

        const now = new Date().toLocaleTimeString("de-DE");

        // main chart
        chart.data.labels.push(now);
        chart.data.datasets[0].data.push(data.t1);
        chart.data.datasets[1].data.push(data.t2);

        trimChartData();
        chart.update();

        // relay chart (safe guard)
        if (relayChart) {
            const relayValue = data.relay === "ON" ? 1 : 0;

            relayChart.data.labels.push(now);
            relayChart.data.datasets[0].data.push(relayValue);

            while (relayChart.data.labels.length > maxPoints) {
                relayChart.data.labels.shift();
                relayChart.data.datasets[0].data.shift();
            }

            relayChart.update();
        }
    };

    ws.onclose = function() {
        if (runtimeTimer) {
            clearInterval(runtimeTimer);
            runtimeTimer = null;
        }
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

function exportCSV() {
    window.location.href = "/measurements/export";
}

/* ------------------- Relay ------------------- */

function initRelayChart() {
    const ctx = document.getElementById("relayChart").getContext("2d");

    relayChart = new Chart(ctx, {
        type: "line",
        data: {
            labels: [],
            datasets: [{
                label: "Relay (0/1)",
                data: [],
                borderColor: "blue",
                stepped: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: {
                padding: {
                    top: 10,
                    bottom: 10
                }
            },
            scales: {
                y: {
                    min: -0.1,
                    max: 1.1,
                    ticks: {
                        stepSize: 1
                    }
                }
            }
        }
    });
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
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.getElementById("themeToggle").checked = theme === "dark";
    localStorage.setItem("theme", theme);
}

async function initTheme() {
    const toggle = document.getElementById("themeToggle");

    // 1. get theme (prefer localStorage for speed)
    let theme = localStorage.getItem("theme");

    if (!theme) {
        const data = await api("/get_theme");
        theme = data.theme;
    }

    // 2. apply theme
    applyTheme(theme);

    // 3. bind toggle
    toggle.addEventListener("change", async () => {
        const newTheme = toggle.checked ? "dark" : "light";

        applyTheme(newTheme); // immediate UI update
        await fetch(`/set_theme?theme=${newTheme}`);
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
    initRelayChart();

    const pointLimit = document.getElementById("pointLimit");
    maxPoints = parseInt(pointLimit.value, 10);

    pointLimit.addEventListener("change", async (e) => {
        const value = parseInt(e.target.value, 10);

        maxPoints = value;
        await fetch(`/set_point_limit?limit=${value}`);

        // clear both charts
        chart.data.labels = [];
        chart.data.datasets.forEach(ds => ds.data = []);

        relayChart.data.labels = [];
        relayChart.data.datasets[0].data =  [];

        chart.update();
        relayChart.update();
    });

    await initPointLimit();

    await Promise.all([
        initLogging(),
        initTheme(),
        initInterval()
    ]);
    initWebSocket();
});

function showPage(pageId) {
    document.querySelectorAll(".page").forEach(page => {
        page.classList.remove("active");
    });

    document.getElementById(pageId).classList.add("active");
}

let maxPoints = 10;
async function loadHistory(limit = maxPoints) {
    maxPoints = limit;

    const response = await fetch(`/measurements/history?limit=${limit}`);
    const rows = await response.json();

    chart.data.labels = [];
    chart.data.datasets[0].data = [];
    chart.data.datasets[1].data = [];

    rows.forEach(row => {
        chart.data.labels.push(row[0]);
        chart.data.datasets[0].data.push(row[1]);
        chart.data.datasets[1].data.push(row[2]);
    });

    trimChartData();
    chart.update();
}
function trimChartData() {
    while (chart.data.labels.length > maxPoints) {
        chart.data.labels.shift();
        chart.data.datasets[0].data.shift();
        chart.data.datasets[1].data.shift();
    }
}
document.addEventListener("DOMContentLoaded", () => {
    const pointLimit = document.getElementById("pointLimit");

    maxPoints = parseInt(pointLimit.value, 10);

    pointLimit.addEventListener("change", function() {
        loadHistory(parseInt(this.value, 10));
    });

    loadHistory(maxPoints);
});

let ws = new WebSocket("ws://" + location.host + "/ws");

ws.onmessage = function(event) {
    let data = JSON.parse(event.data);

    document.getElementById("t1").textContent = data.t1;
    document.getElementById("h1").textContent = data.h1;
    document.getElementById("tp1").textContent = data.tp1;

    document.getElementById("t2").textContent = data.t2;
    document.getElementById("h2").textContent = data.h2;
    document.getElementById("tp2").textContent = data.tp2;

    document.getElementById("delta_tp").textContent = data.delta_tp;
    document.getElementById("relay").textContent = data.relay;

    const now = new Date().toLocaleTimeString("de-DE", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });

    chart.data.labels.push(now);
    chart.data.datasets[0].data.push(data.t1);
    chart.data.datasets[1].data.push(data.t2);

    trimChartData();
    chart.update();
};

async function startMeasurements() {
    let count = document.getElementById("measure_count").value;
    await fetch(`/save_measurements?count=${count}`);
}

async function runSQL() {
    const query = document.getElementById("sqlInput").value;

    const response = await fetch("/sql", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ query: query })
    });

    const result = await response.json();

    const tableContainer = document.getElementById("sqlTableContainer");
    const textOutput = document.getElementById("sqlResult");

    tableContainer.innerHTML = "";
    textOutput.textContent = "";

    if (result.type === "table") {
        let table = document.createElement("table");

        let thead = document.createElement("thead");
        let headRow = document.createElement("tr");

        result.columns.forEach(col => {
            let th = document.createElement("th");
            th.textContent = col;
            headRow.appendChild(th);
        });

        thead.appendChild(headRow);
        table.appendChild(thead);

        let tbody = document.createElement("tbody");

        result.rows.forEach(row => {
            let tr = document.createElement("tr");

            row.forEach(cell => {
                let td = document.createElement("td");
                td.textContent = cell;
                tr.appendChild(td);
            });

            tbody.appendChild(tr);
        });

        table.appendChild(tbody);
        tableContainer.appendChild(table);

    } else {
        textOutput.textContent = JSON.stringify(result.data, null, 2);
    }
}
async function resetTable() {
    if (!confirm("Reset table and counter?")) return;

    await fetch("/measurements/reset", {
        method: "DELETE"
    });

    loadRows();
}
async function selectTable() {
    const response = await fetch("/sql", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            query: "SELECT * FROM measurements"
        })
    });

    const result = await response.json();

    const tableContainer = document.getElementById("sqlTableContainer");
    const textOutput = document.getElementById("sqlResult");

    tableContainer.innerHTML = "";
    textOutput.textContent = "";

    if (result.type === "table") {
        let table = document.createElement("table");

        let thead = document.createElement("thead");
        let headRow = document.createElement("tr");

        result.columns.forEach(col => {
            let th = document.createElement("th");
            th.textContent = col;
            headRow.appendChild(th);
        });

        thead.appendChild(headRow);
        table.appendChild(thead);

       let tbody = document.createElement("tbody");

        result.rows.forEach(row => {
            let tr = document.createElement("tr");

            row.forEach(cell => {
                let td = document.createElement("td");
                td.textContent = cell;
                tr.appendChild(td);
            });

            tbody.appendChild(tr);
        });

        table.appendChild(tbody);
        tableContainer.appendChild(table);

    } else {
        textOutput.textContent = JSON.stringify(result.data, null, 2);
    }
}    
const ctx = document.getElementById("liveChart").getContext("2d");

const chart = new Chart(ctx, {
    type: "line",
    data: {
        labels: [],
        datasets: [
            {
                label: "Inside Temp",
                data: []
            },
            {
                label: "Outside Temp",
                data: []
            }
        ]
    },
    options: {
        responsive: true,
        maintainAspectRatio: false
    }
});

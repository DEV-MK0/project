let maxPoints = 10;
let relayChart;
let chart;
let ws;
let programStartTs = null;
let runtimeTimer = null;
let storageChart;
let measurementCounter = 0;
let cpuChart;
let ramChart;
let clockTimer = null;
let editMode = false;
let draggedCard = null;
let autoScrollSpeed = 0;
let autoScrollFrame = null;
let selectedScheduleDays = [];
let latestOverviewState = null;
let latestStorageState = null;
let overviewAnimationPlayed = false;
let storageAnimationPlayed = false;
const chartAnimationFrames = {
    cpu: null,
    ram: null,
    storage: null
};

/* -------------------- Helpers -------------------- */

function getInitialState() {
    const el = document.getElementById("initialState");
    if (!el) return {};

    try {
        return JSON.parse(el.textContent);
    } catch {
        return {};
    }
}

const initialState = getInitialState();

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function playStartupSequence() {
    await refreshOverview();
    await sleep(180);
    await refreshStorageStatus(true);
    await sleep(180);
    initWebSocket();
}

function cancelChartAnimation(key) {
    if (chartAnimationFrames[key]) {
        cancelAnimationFrame(chartAnimationFrames[key]);
        chartAnimationFrames[key] = null;
    }
}

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

function getCardsContainer() {
    return document.getElementById("cardsContainer");
}

function getOrderedCardIds() {
    return Array.from(getCardsContainer().querySelectorAll(".card")).map(card => card.id);
}

async function saveCardOrder() {
    await fetch("/set_card_order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(getOrderedCardIds())
    });
}

function applyCardOrder(order) {
    if (!Array.isArray(order) || order.length === 0) return;

    const container = getCardsContainer();
    const cardsById = {};

    container.querySelectorAll(".card").forEach(card => {
        cardsById[card.id] = card;
    });

    order.forEach(id => {
        if (cardsById[id]) {
            container.appendChild(cardsById[id]);
        }
    });
}

function buildNavbar() {
    const nav = document.getElementById("navLinks");
    const cards = getCardsContainer().querySelectorAll(".card");

    nav.innerHTML = "";

    cards.forEach(card => {
        const link = document.createElement("a");
        link.href = `#${card.id}`;
        link.textContent = card.dataset.navTitle || card.querySelector("h2")?.textContent || card.id;
        nav.appendChild(link);
    });
}

function updateEditModeButton() {
    const icon = document.getElementById("editModeIcon");
    icon.textContent = editMode ? "🔓" : "🔒";
}

function setCardsDraggable(enabled) {
    document.querySelectorAll("#cardsContainer .card").forEach(card => {
        card.draggable = enabled;
    });
}

function setEditMode(enabled) {
    editMode = !!enabled;
    document.body.classList.toggle("edit-mode", editMode);
    setCardsDraggable(editMode);
    updateEditModeButton();
}

async function initEditMode() {
    setEditMode(!!initialState.editMode);

    document.getElementById("editModeToggle").addEventListener("click", async () => {
        setEditMode(!editMode);
        await fetch(`/set_edit_mode?enabled=${editMode}`);
    });
}

function clearDragMarkers() {
    document.querySelectorAll(".drag-over-top, .drag-over-bottom").forEach(card => {
        card.classList.remove("drag-over-top", "drag-over-bottom");
    });
}

function initDragAndDrop() {
    document.querySelectorAll("#cardsContainer .card").forEach(card => {
        card.addEventListener("dragstart", (event) => {
            if (!editMode) {
                event.preventDefault();
                return;
            }

            draggedCard = card;
            card.classList.add("dragging");
            event.dataTransfer.effectAllowed = "move";
        });

        card.addEventListener("dragend", async () => {
            card.classList.remove("dragging");
            clearDragMarkers();
            stopAutoScroll();
            draggedCard = null;
            buildNavbar();
            await saveCardOrder();
        });

        card.addEventListener("dragover", (event) => {
            if (!editMode || !draggedCard || draggedCard === card) return;

            event.preventDefault();

            handleAutoScroll(event.clientY);

            const rect = card.getBoundingClientRect();
            const middle = rect.top + rect.height / 2;

            clearDragMarkers();

            if (event.clientY < middle) {
                card.classList.add("drag-over-top");
            } else {
                card.classList.add("drag-over-bottom");
            }
        });

        card.addEventListener("dragleave", () => {
            card.classList.remove("drag-over-top", "drag-over-bottom");
        });

        card.addEventListener("drop", (event) => {
            if (!editMode || !draggedCard || draggedCard === card) return;

            event.preventDefault();

            const rect = card.getBoundingClientRect();
            const middle = rect.top + rect.height / 2;

            if (event.clientY < middle) {
                card.parentNode.insertBefore(draggedCard, card);
            } else {
                card.parentNode.insertBefore(draggedCard, card.nextSibling);
            }

            clearDragMarkers();
            stopAutoScroll();
        });
    });

    document.addEventListener("drop", stopAutoScroll);
    document.addEventListener("dragend", stopAutoScroll);
}

function clampMeasurementCount(value) {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

function applyRelayState(relayState) {
    const relayEl = document.getElementById("relay");
    if (!relayEl) return;

    const state = relayState === "ON" ? "ON" : "OFF";
    relayEl.dataset.relayState = state;
    relayEl.textContent = state;
    relayEl.classList.toggle("relay-on", state === "ON");
    relayEl.classList.toggle("relay-off", state === "OFF");
}

function getDbLimitConstraints(unit) {
    if (unit === "KB") {
        return { min: 16, step: 1 };
    }

    return { min: 1, step: 1 };
}

function applyDbLimitInputConstraints(unit) {
    const input = document.getElementById("dbLimitValue");
    if (!input) return;

    const { min, step } = getDbLimitConstraints(unit);
    input.min = String(min);
    input.step = String(step);

    const current = parseFloat(input.value);
    if (!Number.isFinite(current) || current < min) {
        input.value = String(min);
    }
}

function animateOverviewDoughnut(chartKey, chartInstance, percent, color, duration = 800) {
    if (!chartInstance) return;

    cancelChartAnimation(chartKey);

    const start = performance.now();

    function frame(now) {
        const progress = Math.min((now - start) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        const current = percent * eased;

        chartInstance.data.datasets[0].data = [current, Math.max(100 - current, 0)];
        chartInstance.data.datasets[0].backgroundColor = [color, "#cbd5e1"];
        chartInstance.options.plugins.centerText.text = `${Math.round(current)}%`;
        chartInstance.options.plugins.centerText.color = color;
        chartInstance.update("none");

        if (progress < 1) {
            chartAnimationFrames[chartKey] = requestAnimationFrame(frame);
            return;
        }

        chartAnimationFrames[chartKey] = null;
        chartInstance.data.datasets[0].data = [percent, Math.max(100 - percent, 0)];
        chartInstance.data.datasets[0].backgroundColor = [color, "#cbd5e1"];
        chartInstance.options.plugins.centerText.text = `${percent.toFixed(0)}%`;
        chartInstance.options.plugins.centerText.color = color;
        chartInstance.update("none");
    }

    chartAnimationFrames[chartKey] = requestAnimationFrame(frame);
}

function animateStoragePieChart(usedBytes, freeBytes, duration = 800) {
    if (!storageChart) return;

    cancelChartAnimation("storage");

    const start = performance.now();
    const total = usedBytes + freeBytes;

    function frame(now) {
        const progress = Math.min((now - start) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);

        const currentUsed = usedBytes * eased;
        const currentFree = Math.max(total - currentUsed, 0);

        storageChart.data.datasets[0].data = [currentUsed, currentFree];
        storageChart.update("none");

        if (progress < 1) {
            chartAnimationFrames["storage"] = requestAnimationFrame(frame);
            return;
        }

        chartAnimationFrames["storage"] = null;
        storageChart.data.datasets[0].data = [usedBytes, freeBytes];
        storageChart.update("none");
    }

    chartAnimationFrames["storage"] = requestAnimationFrame(frame);
}

function animateOverviewStorageBar(percent) {
    const bar = document.getElementById("storageBarFill");
    if (!bar) return;

    bar.classList.add("no-transition");
    bar.style.width = "0%";

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            bar.classList.remove("no-transition");
            bar.style.width = `${percent}%`;
        });
    });
}

function startAutoScroll() {
    if (autoScrollFrame) return;

    function step() {
        if (autoScrollSpeed !== 0) {
            window.scrollBy(0, autoScrollSpeed);
        }
        autoScrollFrame = requestAnimationFrame(step);
    }

    autoScrollFrame = requestAnimationFrame(step);
}

function stopAutoScroll() {
    autoScrollSpeed = 0;

    if (autoScrollFrame) {
        cancelAnimationFrame(autoScrollFrame);
        autoScrollFrame = null;
    }
}

function handleAutoScroll(clientY) {
    const edgeThreshold = 260;
    const maxSpeed = 60;
    const minSpeed = 14;
    const viewportHeight = window.innerHeight;

    if (clientY < edgeThreshold) {
        const ratio = (edgeThreshold - clientY) / edgeThreshold;
        autoScrollSpeed = -Math.round(minSpeed + (maxSpeed - minSpeed) * ratio);
        startAutoScroll();
    } else if (clientY > viewportHeight - edgeThreshold) {
        const ratio = (clientY - (viewportHeight - edgeThreshold)) / edgeThreshold;
        autoScrollSpeed = Math.round(minSpeed + (maxSpeed - minSpeed) * ratio);
        startAutoScroll();
    } else {
        stopAutoScroll();
    }
}

function updateEditModeButton() {
    const icon = document.getElementById("editModeIcon");
    const btn = document.getElementById("editModeToggle");

    icon.textContent = editMode ? "🔓" : "🔒";

    btn.classList.remove("locked", "unlocked");

    if (editMode) {
        btn.classList.add("unlocked"); // green
    } else {
        btn.classList.add("locked");   // red
    }
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

    document.getElementById("runtime").textContent = formatDuration(runtime);
}

function formatDate24() {
    const now = new Date();

    const time = now.toLocaleTimeString("de-DE", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
    });

    const date = now.toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric"
    });

    return { time, date };
}

function updateOverviewClock() {
    const { time, date } = formatDate24();

    const timeEl = document.getElementById("overviewTime");
    const dateEl = document.getElementById("overviewDate");

    if (timeEl) timeEl.textContent = time;
    if (dateEl) dateEl.textContent = date;
}

function updateOverviewStorageUi(diskPercent, diskUsed, diskTotal, animate = false) {
    const storagePercentText = document.getElementById("storagePercentText");
    const storageUsedText = document.getElementById("storageUsedText");
    const storageTotalText = document.getElementById("storageTotalText");
    const storageBarFill = document.getElementById("storageBarFill");

    if (storagePercentText) {
        storagePercentText.textContent = `${diskPercent.toFixed(1)}%`;
        storagePercentText.style.color = "";
    }

    if (storageUsedText) {
        storageUsedText.textContent = `Used: ${formatBytesToBestUnit(diskUsed)}`;
    }

    if (storageTotalText) {
        storageTotalText.textContent = `Total: ${formatBytesToBestUnit(diskTotal)}`;
    }

    if (storageBarFill) {
        if (animate) {
            animateOverviewStorageBar(diskPercent);
        } else {
            storageBarFill.style.width = `${diskPercent}%`;
        }
    }
}

function formatBytesToBestUnit(bytes) {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let index = 0;

    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
    }

    const decimals = value >= 100 || index === 0 ? 0 : 2;
    return `${value.toFixed(decimals)} ${units[index]}`;
}

const doughnutCenterTextPlugin = {
    id: "doughnutCenterTextPlugin",
    afterDraw(chart) {
        const centerText = chart?.options?.plugins?.centerText || {};
        const text = centerText.text;

        if (!text) return;

        const { ctx, chartArea } = chart;
        if (!chartArea) return;

        const x = (chartArea.left + chartArea.right) / 2;
        const y = (chartArea.top + chartArea.bottom) / 2;

        ctx.save();
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = centerText.color || getComputedStyle(document.documentElement).getPropertyValue("--muted").trim() || "#6b7280";
        ctx.font = "bold 22px Arial";
        ctx.fillText(text, x, y);
        ctx.restore();
    }
};

function createOverviewDoughnut(canvasId, initialText = "0%") {
    const ctx = document.getElementById(canvasId).getContext("2d");

    return new Chart(ctx, {
        type: "doughnut",
        data: {
            labels: ["Used", "Free"],
            datasets: [{
                data: [0, 100],
                backgroundColor: ["#22c55e", "#cbd5e1"],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: "75%",
            animation: {
                duration: 900,
                easing: "easeOutCubic"
            },
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    enabled: true
                },
                centerText: {
                    text: initialText,
                    color: getComputedStyle(document.documentElement).getPropertyValue("--muted").trim() || "#6b7280"
                }
            }
        },
        plugins: [doughnutCenterTextPlugin]
    });
}

function initOverviewCharts() {
    cpuChart = createOverviewDoughnut("cpuChart");
    ramChart = createOverviewDoughnut("ramChart");
}

async function refreshOverview() {
    const data = await api("/system_overview");
    latestOverviewState = data;

    const cpuPercent = Math.max(0, Math.min(data.cpuPercent ?? 0, 100));
    const ramPercent = Math.max(0, Math.min(data.memory?.percent ?? 0, 100));
    const ramUsed = data.memory?.used ?? 0;
    const ramTotal = data.memory?.total ?? 0;
    const cpuFreqGHz = data.cpuFrequencyGHz ?? null;

    const diskPercent = Math.max(0, Math.min(data.disk?.percent ?? 0, 100));
    const diskUsed = data.disk?.used ?? 0;
    const diskTotal = data.disk?.total ?? 0;

    const cpuColor = getUsageColor(cpuPercent);
    const ramColor = getUsageColor(ramPercent);

    if (!overviewAnimationPlayed) {
        animateOverviewDoughnut("cpu", cpuChart, cpuPercent, cpuColor);
        animateOverviewDoughnut("ram", ramChart, ramPercent, ramColor);
        updateOverviewStorageUi(diskPercent, diskUsed, diskTotal, true);
        overviewAnimationPlayed = true;
    } else {
        if (cpuChart) {
            cpuChart.data.datasets[0].data = [cpuPercent, 100 - cpuPercent];
            cpuChart.data.datasets[0].backgroundColor = [cpuColor, "#cbd5e1"];
            cpuChart.options.plugins.centerText.text = `${cpuPercent.toFixed(0)}%`;
            cpuChart.options.plugins.centerText.color = cpuColor;
            cpuChart.update("none");
        }

        if (ramChart) {
            ramChart.data.datasets[0].data = [ramPercent, 100 - ramPercent];
            ramChart.data.datasets[0].backgroundColor = [ramColor, "#cbd5e1"];
            ramChart.options.plugins.centerText.text = `${ramPercent.toFixed(0)}%`;
            ramChart.options.plugins.centerText.color = ramColor;
            ramChart.update("none");
        }

        updateOverviewStorageUi(diskPercent, diskUsed, diskTotal, false);
    }

    const cpuUnitsText = document.getElementById("cpuUnitsText");
    const ramUnitsText = document.getElementById("ramUnitsText");

    if (cpuUnitsText) {
        cpuUnitsText.textContent = cpuFreqGHz != null ? `${cpuFreqGHz.toFixed(2)} GHz` : "- GHz";
    }

    if (ramUnitsText) {
        ramUnitsText.textContent = `${formatBytesToBestUnit(ramUsed)} / ${formatBytesToBestUnit(ramTotal)}`;
    }
}

/* -------------------- Schedule -------------------- */

function normalizeTimeInput(value) {
    const cleaned = String(value).replace(/[^\d:]/g, "").trim();

    if (/^\d{2}:\d{2}$/.test(cleaned)) {
        return cleaned;
    }

    if (/^\d{4}$/.test(cleaned)) {
        return `${cleaned.slice(0, 2)}:${cleaned.slice(2, 4)}`;
    }

    return cleaned;
}

function isValidTimeString(value) {
    if (!/^\d{2}:\d{2}$/.test(value)) return false;

    const [hour, minute] = value.split(":").map(Number);
    return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function formatTimeInputLive(input) {
    if (!input) return;

    let digits = input.value.replace(/\D/g, "").slice(0, 4);

    if (digits.length >= 3) {
        input.value = `${digits.slice(0, 2)}:${digits.slice(2)}`;
    } else {
        input.value = digits;
    }
}

function getSelectedScheduleDays() {
    return Array.from(document.querySelectorAll(".day-toggle.active"))
        .map(btn => btn.dataset.day);
}

function applyScheduleDays(days) {
    selectedScheduleDays = Array.isArray(days) ? days : [];

    document.querySelectorAll(".day-toggle").forEach(btn => {
        btn.classList.toggle("active", selectedScheduleDays.includes(btn.dataset.day));
    });
}

function initScheduleDayButtons() {
    document.querySelectorAll(".day-toggle").forEach(btn => {
        btn.addEventListener("click", () => {
            btn.classList.toggle("active");
            selectedScheduleDays = getSelectedScheduleDays();
        });
    });
}

function renderScheduleStatus(data) {
    const label = document.getElementById("scheduleLabel");
    const status = document.getElementById("scheduleStatusText");

    if (label) {
        label.textContent = data.enabled ? "Schedule enabled" : "Schedule disabled";
    }

    if (status) {
        const daysText = (data.days || []).length ? data.days.join(", ") : "no days selected";

        let stateText = "Measuring is currently allowed.";
        if (data.enabled && data.measuringAllowedNow === false) {
            stateText = "Measuring is currently blocked by schedule.";
        }

        status.textContent = `${stateText} ${data.startTime} to ${data.endTime}, action ${data.action}, days: ${daysText}.`;
    }
}

function initScheduleTimeInputs() {
    const start = document.getElementById("scheduleStartTime");
    const end = document.getElementById("scheduleEndTime");

    [start, end].forEach(input => {
        if (!input) return;

        input.addEventListener("input", () => {
            formatTimeInputLive(input);
        });

        input.addEventListener("blur", () => {
            input.value = normalizeTimeInput(input.value);
        });
    });
}

async function loadSchedule(useInitial = false) {
    const data = useInitial
        ? {
            ...initialState.schedule,
            measuringAllowedNow: true
        }
        : await api("/get_schedule");

    const enabled = document.getElementById("scheduleEnabled");
    const start = document.getElementById("scheduleStartTime");
    const end = document.getElementById("scheduleEndTime");
    const action = document.getElementById("scheduleAction");

    if (enabled) enabled.checked = !!data.enabled;
    if (start) start.value = data.startTime || "00:00";
    if (end) end.value = data.endTime || "17:00";
    if (action) action.value = data.action || "OFF";

    applyScheduleDays(data.days || []);
    renderScheduleStatus(data);
}

async function saveSchedule() {
    const enabled = document.getElementById("scheduleEnabled");
    const start = document.getElementById("scheduleStartTime");
    const end = document.getElementById("scheduleEndTime");
    const action = document.getElementById("scheduleAction");

    const startTime = normalizeTimeInput(start?.value || "");
    const endTime = normalizeTimeInput(end?.value || "");
    const days = getSelectedScheduleDays();

    if (!isValidTimeString(startTime)) {
        alert("Please enter a valid start time in HH:MM format.");
        start?.focus();
        return;
    }

    if (!isValidTimeString(endTime)) {
        alert("Please enter a valid end time in HH:MM format.");
        end?.focus();
        return;
    }

    if (start) start.value = startTime;
    if (end) end.value = endTime;

    const payload = {
        enabled: !!enabled?.checked,
        startTime,
        endTime,
        action: action?.value || "OFF",
        days
    };

    const result = await api("/set_schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });

    if (result.error) {
        alert(result.error);
        return;
    }

    applyScheduleDays(result.days || []);
    renderScheduleStatus(result);
    selectedScheduleDays = result.days || [];
}

/* ------------------- Storage ------------------- */

function formatBytes(bytes) {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let index = 0;

    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
    }

    const decimals = value >= 100 || index === 0 ? 0 : 2;
    return `${value.toFixed(decimals)} ${units[index]}`;
}

function initStorageChart() {
    const ctx = document.getElementById("storageChart").getContext("2d");

    storageChart = new Chart(ctx, {
        type: "pie",
        data: {
            labels: ["Used", "Free"],
            datasets: [{
                data: [0, 0],
                backgroundColor: ["#dc2626", "#9ca3af"],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: {
                duration: 900,
                easing: "easeOutCubic"
            },
            plugins: {
                legend: {
                    display: true
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const value = context.raw || 0;
                            return `${context.label}: ${formatBytes(value)}`;
                        }
                    }
                }
            }
        }
    });
}

async function refreshStorageStatus(animate = true) {
    const data = await api("/storage_status");
    latestStorageState = data;

    const sizeBytes = Math.max(data.dbSizeBytes ?? 0, 0);
    const limitBytes = Math.max(data.dbLimitBytes ?? 0, 0);
    const usedBytes = Math.min(sizeBytes, limitBytes);
    const freeBytes = Math.max(limitBytes - usedBytes, 0);

    const usedPercent = limitBytes > 0 ? (usedBytes / limitBytes) * 100 : 0;

    document.getElementById("dbSizeText").textContent = formatBytes(sizeBytes);
    document.getElementById("dbLimitText").textContent = formatBytes(limitBytes);
    document.getElementById("dbUsageText").textContent = `${usedPercent.toFixed(1)}%`;
    document.getElementById("dbLimitValue").value = data.dbLimitValue;
    document.getElementById("dbLimitUnit").value = data.dbLimitUnit;

    applyDbLimitInputConstraints(data.dbLimitUnit);

    const notice = document.getElementById("storageLimitNotice");
    notice.textContent = data.loggingStoppedByLimit
        ? "Logging stopped because the database reached the configured limit."
        : "Logging stops automatically when the configured limit is reached.";

    if (storageChart) {
        if (animate && !storageAnimationPlayed) {
            animateStoragePieChart(usedBytes, freeBytes);
            storageAnimationPlayed = true;
        } else {
            storageChart.data.datasets[0].data = [usedBytes, freeBytes];
            storageChart.update("none");
        }
    }

    if (data.loggingStoppedByLimit) {
        const toggle = document.getElementById("logToggle");
        if (toggle) {
            toggle.checked = false;
        }
    }
}

async function saveDbLimit() {
    const input = document.getElementById("dbLimitValue");
    const unit = document.getElementById("dbLimitUnit").value;

    applyDbLimitInputConstraints(unit);

    let value = parseFloat(input.value);

    if (!Number.isFinite(value)) {
        alert("Please enter a valid database limit.");
        input.focus();
        return;
    }

    const { min } = getDbLimitConstraints(unit);

    if (value < min) {
        value = min;
        input.value = String(min);
    }

    const result = await api(`/set_db_limit?value=${encodeURIComponent(value)}&unit=${encodeURIComponent(unit)}`);

    if (result.error) {
        alert(result.error);
        return;
    }

    await refreshStorageStatus(false);
    await initLogging();
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

        if (data.scheduleBlocked) {
            document.getElementById("t1").textContent = "-";
            document.getElementById("h1").textContent = "-";
            document.getElementById("tp1").textContent = "-";

            document.getElementById("t2").textContent = "-";
            document.getElementById("h2").textContent = "-";
            document.getElementById("tp2").textContent = "-";

            document.getElementById("delta_tp").textContent = "-";
            applyRelayState("OFF");

            updateRuntime();

            if (data.systemOverview) {
                updateOverviewFromWs(data.systemOverview);
            }

            if (data.storageStatus) {
                updateStorageFromWs(data.storageStatus);
            }

            return;
        }

        if (data.systemOverview) {
            updateOverviewFromWs(data.systemOverview);
        }

        if (data.storageStatus) {
            updateStorageFromWs(data.storageStatus);
        }

        if (data.program_start_ts) {
            programStartTs = data.program_start_ts;
        }

        if (!runtimeTimer && programStartTs) {
            runtimeTimer = setInterval(updateRuntime, 1000);
        }

        document.getElementById("t1").textContent = data.t1;
        document.getElementById("h1").textContent = data.h1;
        document.getElementById("tp1").textContent = data.tp1;

        document.getElementById("t2").textContent = data.t2;
        document.getElementById("h2").textContent = data.h2;
        document.getElementById("tp2").textContent = data.tp2;

        document.getElementById("delta_tp").textContent = data.delta_tp;
        applyRelayState(data.relay);

        updateRuntime();

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

function updateOverviewFromWs(system) {
    latestOverviewState = system;

    const cpuPercent = Math.max(0, Math.min(system.cpuPercent ?? 0, 100));
    const ramPercent = Math.max(0, Math.min(system.memory?.percent ?? 0, 100));
    const ramUsed = system.memory?.used ?? 0;
    const ramTotal = system.memory?.total ?? 0;
    const cpuFreqGHz = system.cpuFrequencyGHz ?? null;

    const diskPercent = Math.max(0, Math.min(system.disk?.percent ?? 0, 100));
    const diskUsed = system.disk?.used ?? 0;
    const diskTotal = system.disk?.total ?? 0;

    const cpuColor = getUsageColor(cpuPercent);
    const ramColor = getUsageColor(ramPercent);

    if (cpuChart) {
        cpuChart.data.datasets[0].data = [cpuPercent, 100 - cpuPercent];
        cpuChart.data.datasets[0].backgroundColor = [cpuColor, "#cbd5e1"];
        cpuChart.options.plugins.centerText.text = `${cpuPercent.toFixed(0)}%`;
        cpuChart.options.plugins.centerText.color = cpuColor;
        cpuChart.update();
    }

    if (ramChart) {
        ramChart.data.datasets[0].data = [ramPercent, 100 - ramPercent];
        ramChart.data.datasets[0].backgroundColor = [ramColor, "#cbd5e1"];
        ramChart.options.plugins.centerText.text = `${ramPercent.toFixed(0)}%`;
        ramChart.options.plugins.centerText.color = ramColor;
        ramChart.update();
    }

    const cpuUnitsText = document.getElementById("cpuUnitsText");
    const ramUnitsText = document.getElementById("ramUnitsText");

    if (cpuUnitsText) {
        cpuUnitsText.textContent = cpuFreqGHz != null ? `${cpuFreqGHz.toFixed(2)} GHz` : "- GHz";
    }

    if (ramUnitsText) {
        ramUnitsText.textContent = `${formatBytesToBestUnit(ramUsed)} / ${formatBytesToBestUnit(ramTotal)}`;
    }

    updateOverviewStorageUi(diskPercent, diskUsed, diskTotal, false);
}

function updateStorageFromWs(data) {
    latestStorageState = data;

    const sizeBytes = Math.max(data.dbSizeBytes ?? 0, 0);
    const limitBytes = Math.max(data.dbLimitBytes ?? 0, 0);
    const usedBytes = Math.min(sizeBytes, limitBytes);
    const freeBytes = Math.max(limitBytes - usedBytes, 0);

    const usedPercent = limitBytes > 0 ? (usedBytes / limitBytes) * 100 : 0;

    document.getElementById("dbSizeText").textContent = formatBytes(sizeBytes);
    document.getElementById("dbLimitText").textContent = formatBytes(limitBytes);
    document.getElementById("dbUsageText").textContent = `${usedPercent.toFixed(1)}%`;
    document.getElementById("dbLimitValue").value = data.dbLimitValue;
    document.getElementById("dbLimitUnit").value = data.dbLimitUnit;

    applyDbLimitInputConstraints(data.dbLimitUnit);

    const notice = document.getElementById("storageLimitNotice");
    notice.textContent = data.loggingStoppedByLimit
        ? "Logging stopped because the database reached the configured limit."
        : "Logging stops automatically when the configured limit is reached.";

    if (storageChart) {
        storageChart.data.datasets[0].data = [usedBytes, freeBytes];
        storageChart.update();
    }

    if (data.loggingStoppedByLimit) {
        const toggle = document.getElementById("logToggle");
        if (toggle) {
            toggle.checked = false;
        }
    }
}

/* -------------------- Measurements -------------------- */

function getUsageColor(percent) {
    if (percent >= 75) return "#dc2626";
    if (percent >= 40) return "#f59e0b";
    return "#22c55e";
}

function getCpuFrequencyGHz() {
    try {
        const cores = navigator.hardwareConcurrency || 0;
        if (!cores) return null;
        return null;
    } catch {
        return null;
    }
}

function formatCpuGHz(value) {
    if (value == null || !Number.isFinite(value)) {
        return "- GHz";
    }
    return `${value.toFixed(2)} GHz`;
}

async function startMeasurements() {
    const input = document.getElementById("measure_count");
    const count = clampMeasurementCount(input.value);
    input.value = count;

    const status = document.getElementById("measureStatus");
    const circle = document.querySelector(".progress-circle .progress");

    status.style.display = "none";
    status.style.color = "var(--success)";
    status.textContent = "✓ Done";

    const intervalValue = parseFloat(document.getElementById("interval").value) || 2;
    const duration = count * intervalValue;

    startProgress(duration);

    const result = await api(`/save_measurements?count=${count}`);

    if (result.status === "blocked_by_schedule") {
        circle.style.stroke = "var(--danger)";
        circle.style.strokeDashoffset = 0;

        status.style.display = "inline";
        status.style.color = "var(--danger)";
        status.textContent = "Blocked by schedule";
        return;
    }

    if (result.status === "stopped") {
        circle.style.stroke = "var(--danger)";
        circle.style.strokeDashoffset = 0;

        status.style.display = "inline";
        status.style.color = "var(--danger)";
        status.textContent = "Stopped: DB limit reached";

        await refreshStorageStatus(false);
        return;
    }

    await refreshStorageStatus(false);
    await initLogging();
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
                        stepSize: 1,
                        callback: function(value) {
                            if (value === 1) return "ON";
                            if (value === 0) return "OFF";
                            return "";
                        }
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
    tableContainer.style.display = "none";
    textOutput.style.display = "none";

    if (result.type === "table") {
        tableContainer.appendChild(createTable(result.columns, result.rows));
        tableContainer.style.display = "block";
    } else {
        textOutput.textContent = JSON.stringify(result.data, null, 2);
        textOutput.style.display = "block";
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
    await refreshStorageStatus();
}

/* -------------------- Logging -------------------- */

async function initLogging() {
    const toggle = document.getElementById("logToggle");
    const label = document.getElementById("logLabel");

    toggle.checked = !!initialState.logging;

    function updateLabel(enabled) {
        label.textContent = enabled
            ? "Logging enabled"
            : "Logging disabled";
    }

    toggle.onchange = async function() {
        const enabled = toggle.checked;
        const result = await api(`/set_logging?enabled=${enabled}`);

        toggle.checked = !!result.logging;
        updateLabel(toggle.checked);
        await refreshStorageStatus(false);
    };

    updateLabel(toggle.checked);
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

    if (cpuChart) cpuChart.update();
    if (ramChart) ramChart.update();

    // 3. bind toggle
    toggle.addEventListener("change", async () => {
        const newTheme = toggle.checked ? "dark" : "light";

        applyTheme(newTheme); // immediate UI update
        if (cpuChart) cpuChart.update();
        if (ramChart) ramChart.update();
        await fetch(`/set_theme?theme=${newTheme}`);
    });
}

/* -------------------- Interval -------------------- */

async function initInterval() {
    document.getElementById("interval").value = initialState.interval ?? 2;
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
    const select = document.getElementById("pointLimit");
    const value = initialState.pointLimit ?? 10;

    select.value = value;
    maxPoints = parseInt(value, 10);
}

/* -------------------- Init -------------------- */

document.addEventListener("DOMContentLoaded", async () => {
    await initCardOrder();
    await initCollapsibleCards();
    await initEditMode();

    initChart();
    initRelayChart();
    initStorageChart();
    initOverviewCharts();
    initScheduleDayButtons();
    initScheduleTimeInputs();
    initDragAndDrop();

    await initPointLimit();
    await initLogging();
    await initInterval();
    await initTheme();
    await loadSchedule(true);

    document.getElementById("measure_count")?.addEventListener("input", (e) => {
        const value = e.target.value.replace(/[^\d]/g, "");
        e.target.value = value === "" ? "" : String(clampMeasurementCount(value));
    });

    document.getElementById("dbLimitUnit")?.addEventListener("change", (e) => {
        applyDbLimitInputConstraints(e.target.value);
    });

    updateOverviewClock();
    if (!clockTimer) {
        clockTimer = setInterval(updateOverviewClock, 1000);
    }

    const pointLimit = document.getElementById("pointLimit");
    maxPoints = parseInt(pointLimit.value, 10);

    pointLimit.addEventListener("change", async (e) => {
        const value = parseInt(e.target.value, 10);

        maxPoints = value;
        await fetch(`/set_point_limit?limit=${value}`);

        chart.data.labels = [];
        chart.data.datasets.forEach(ds => ds.data = []);

        relayChart.data.labels = [];
        relayChart.data.datasets[0].data = [];

        chart.update();
        relayChart.update();
    });

    document.body.classList.remove("ui-loading");

    await sleep(250);
    await playStartupSequence();
});

async function initCollapsibleCards() {
    const collapsedCards = initialState.collapsedCards || {};

    document.querySelectorAll(".card").forEach(card => {
        const id = card.id;
        const btn = card.querySelector(".collapse-btn");

        if (!btn) return;

        if (collapsedCards[id]) {
            card.classList.add("collapsed");
        }

        btn.addEventListener("click", async () => {
            const isCollapsed = card.classList.toggle("collapsed");

            const updated = {};
            document.querySelectorAll(".card").forEach(c => {
                updated[c.id] = c.classList.contains("collapsed");
            });

            await fetch("/set_collapsed_cards", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify(updated)
            });

            if (!isCollapsed) {
                requestAnimationFrame(() => {
                    chart?.resize();
                    relayChart?.resize();
                    storageChart?.resize();
                    cpuChart?.resize();
                    ramChart?.resize();
                });
            }
        });
    });
}

async function initCardOrder() {
    applyCardOrder(initialState.cardOrder || []);
    buildNavbar();
}

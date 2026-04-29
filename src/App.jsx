import React, { useState, useRef, useCallback } from "react";
import { checkConnection, createSlot, bookSlot, cancelBooking, completeBooking, getSlot, listSlots, getSlotCount } from "../lib.js/stellar.js";

const nowTs = () => Math.floor(Date.now() / 1000);

const initialForm = () => ({
    id: "slot1",
    provider: "",
    customer: "",
    serviceName: "Consultation",
    date: String(nowTs()),
    startTime: String(nowTs()),
    endTime: String(nowTs() + 3600),
    price: "1000",
});

const toOutput = (value) => {
    if (typeof value === "string") return value;
    return JSON.stringify(value, null, 2);
};

const truncateAddress = (addr) => {
    if (!addr || addr.length < 12) return addr;
    return addr.slice(0, 8) + "..." + addr.slice(-4);
};

export default function App() {
    const [form, setForm] = useState(initialForm);
    const [output, setOutput] = useState("Ready.");
    const [walletState, setWalletState] = useState("Wallet: not connected");
    const [walletKey, setWalletKey] = useState("");
    const [isBusy, setIsBusy] = useState(false);
    const [busyAction, setBusyAction] = useState("");
    const [countValue, setCountValue] = useState("-");
    const [status, setStatus] = useState("idle");
    const [activeTab, setActiveTab] = useState("create");
    const [confirmAction, setConfirmAction] = useState(null);
    const confirmTimer = useRef(null);

    const setField = (event) => {
        const { name, value } = event.target;
        setForm((prev) => ({ ...prev, [name]: value }));
    };

    const runAction = async (action, actionName) => {
        setIsBusy(true);
        setBusyAction(actionName || "");
        try {
            const result = await action();
            setOutput(toOutput(result ?? "No data found"));
            setStatus("success");
        } catch (error) {
            setOutput(error?.message || String(error));
            setStatus("error");
        } finally {
            setIsBusy(false);
            setBusyAction("");
        }
    };

    const onConnect = () => runAction(async () => {
        const user = await checkConnection();
        const next = user ? `Wallet: ${user.publicKey}` : "Wallet: not connected";
        setWalletState(next);
        if (user) {
            setWalletKey(user.publicKey);
            setForm(prev => ({ ...prev, provider: user.publicKey, customer: user.publicKey }));
        }
        return next;
    }, "connect");

    const onCreateSlot = () => runAction(async () => createSlot({
        id: form.id.trim(),
        provider: form.provider.trim(),
        serviceName: form.serviceName.trim(),
        date: Number(form.date || nowTs()),
        startTime: Number(form.startTime || nowTs()),
        endTime: Number(form.endTime || nowTs() + 3600),
        price: form.price.trim(),
    }), "createSlot");

    const onBookSlot = () => runAction(async () => bookSlot({
        id: form.id.trim(),
        customer: form.customer.trim(),
    }), "bookSlot");

    const handleCancelBooking = useCallback(() => {
        if (confirmAction === "cancel") {
            clearTimeout(confirmTimer.current);
            setConfirmAction(null);
            runAction(async () => cancelBooking({
                id: form.id.trim(),
                caller: form.customer.trim() || form.provider.trim(),
            }), "cancelBooking");
        } else {
            setConfirmAction("cancel");
            confirmTimer.current = setTimeout(() => setConfirmAction(null), 3000);
        }
    }, [confirmAction, form.id, form.customer, form.provider]);

    const onCompleteBooking = () => runAction(async () => completeBooking({
        id: form.id.trim(),
        provider: form.provider.trim(),
    }), "completeBooking");

    const onGetSlot = () => runAction(async () => getSlot(form.id.trim()), "getSlot");

    const onList = () => runAction(async () => listSlots(), "list");

    const onCount = () => runAction(async () => {
        const value = await getSlotCount();
        setCountValue(String(value));
        return { count: value };
    }, "count");

    const isConnected = walletKey.length > 0;

    const btnLoadingText = (actionName, label) => {
        if (isBusy && busyAction === actionName) return "Processing...";
        return label;
    };

    const btnCls = (actionName, base) => {
        let cls = base;
        if (isBusy && busyAction === actionName) cls += " btn-loading";
        return cls;
    };

    const outputClass = () => {
        if (status === "success") return "output-success";
        if (status === "error") return "output-error";
        return "output-idle";
    };

    return (
        <main className="app">
            {/* Calendar Hero */}
            <div className="calendar-hero">
                <div className="hero-top">
                    <div className="hero-content">
                        <p className="kicker">Stellar Soroban Project 4</p>
                        <h1>Booking & Reservation</h1>
                        <p className="subtitle">
                            Create service time slots, book appointments, cancel or complete bookings on the Stellar blockchain.
                        </p>
                    </div>
                    <div className="wallet-card">
                        <button type="button" className={btnCls("connect", "connect-btn")} id="connectWallet" onClick={onConnect} disabled={isBusy}>
                            {btnLoadingText("connect", "Connect Freighter")}
                        </button>
                        <span className="wallet-status" id="walletState">
                            <span className={`status-dot ${isConnected ? "connected" : "disconnected"}`}></span>
                            {isConnected ? `${truncateAddress(walletKey)} - Connected` : "Not Connected"}
                        </span>
                        <span className="slot-count">Slots: {countValue}</span>
                    </div>
                </div>
            </div>

            {/* Stats Bar */}
            <div className="stats-bar">
                <div className="stat-item">
                    <div className="stat-label">Total Slots</div>
                    <div className="stat-value">{countValue}</div>
                </div>
                <div className="stat-item">
                    <div className="stat-label">Status</div>
                    <div className="stat-value">{isBusy ? "..." : "Idle"}</div>
                </div>
                <div className="stat-item">
                    <div className="stat-label">Network</div>
                    <div className="stat-value">Stellar</div>
                </div>
            </div>

            {/* Tab Navigation */}
            <div className="tab-nav">
                <button className={`tab-btn ${activeTab === "create" ? "active" : ""}`} onClick={() => setActiveTab("create")}>Create Slot</button>
                <button className={`tab-btn ${activeTab === "booking" ? "active" : ""}`} onClick={() => setActiveTab("booking")}>Booking</button>
                <button className={`tab-btn ${activeTab === "query" ? "active" : ""}`} onClick={() => setActiveTab("query")}>Query</button>
            </div>

            {/* Create Service Slot */}
            {activeTab === "create" && (
                <div className="section-card">
                    <div className="section-header slot-header">
                        <h2>Create Service Slot</h2>
                    </div>
                    <div className="section-body">
                        <div className="form-grid">
                            <div className="cal-field">
                                <label htmlFor="entryId">Slot ID (Symbol, &lt;= 32 chars)</label>
                                <input id="entryId" name="id" value={form.id} onChange={setField} />
                                <span className="helper">Unique identifier, max 32 characters</span>
                            </div>
                            <div className="cal-field">
                                <label htmlFor="provider">Provider Address</label>
                                <input id="provider" name="provider" value={form.provider} onChange={setField} placeholder="G..." />
                                <span className="helper">Stellar public key starting with G...</span>
                            </div>
                            <div className="cal-field">
                                <label htmlFor="serviceName">Service Name</label>
                                <input id="serviceName" name="serviceName" value={form.serviceName} onChange={setField} />
                            </div>
                            <div className="cal-field">
                                <label htmlFor="price">Price (i128 stroops)</label>
                                <input id="price" name="price" value={form.price} onChange={setField} type="number" />
                                <span className="helper">Amount in stroops (1 XLM = 10,000,000 stroops)</span>
                            </div>
                        </div>

                        <div className="time-fields" style={{ marginTop: "1rem" }}>
                            <div className="cal-field time-field">
                                <label htmlFor="date">Date (u64 timestamp)</label>
                                <input id="date" name="date" value={form.date} onChange={setField} type="number" />
                                <span className="helper">Unix timestamp in seconds</span>
                            </div>
                            <div className="cal-field time-field">
                                <label htmlFor="startTime">Start Time (u64)</label>
                                <input id="startTime" name="startTime" value={form.startTime} onChange={setField} type="number" />
                                <span className="helper">Unix timestamp in seconds</span>
                            </div>
                            <div className="cal-field time-field">
                                <label htmlFor="endTime">End Time (u64)</label>
                                <input id="endTime" name="endTime" value={form.endTime} onChange={setField} type="number" />
                                <span className="helper">Unix timestamp in seconds</span>
                            </div>
                        </div>

                        <div className="button-row">
                            <button type="button" className={btnCls("createSlot", "btn-cal btn-cal-primary")} onClick={onCreateSlot} disabled={isBusy}>
                                {btnLoadingText("createSlot", "Create Slot")}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Booking Management */}
            {activeTab === "booking" && (
                <div className="section-card">
                    <div className="section-header booking-header">
                        <h2>Booking Management</h2>
                    </div>
                    <div className="section-body">
                        <div className="form-grid">
                            <div className="cal-field full-span">
                                <label htmlFor="customer">Customer Address</label>
                                <input id="customer" name="customer" value={form.customer} onChange={setField} placeholder="G..." />
                                <span className="helper">Stellar public key starting with G...</span>
                            </div>
                        </div>
                        <div className="button-row">
                            <button type="button" className={btnCls("bookSlot", "btn-cal btn-cal-success")} onClick={onBookSlot} disabled={isBusy}>
                                {btnLoadingText("bookSlot", "Book Slot")}
                            </button>
                            <button
                                type="button"
                                className={`${btnCls("cancelBooking", "btn-cal btn-cal-danger")} ${confirmAction === "cancel" ? "btn-confirm" : ""}`}
                                onClick={handleCancelBooking}
                                disabled={isBusy}
                            >
                                {confirmAction === "cancel" ? "Confirm Cancel?" : btnLoadingText("cancelBooking", "Cancel Booking")}
                            </button>
                            <button type="button" className={btnCls("completeBooking", "btn-cal btn-cal-primary")} onClick={onCompleteBooking} disabled={isBusy}>
                                {btnLoadingText("completeBooking", "Complete Booking")}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Query Actions */}
            {activeTab === "query" && (
                <div className="section-card">
                    <div className="section-header results-header">
                        <h2>Query Slots</h2>
                    </div>
                    <div className="section-body">
                        <div className="button-row">
                            <button type="button" className={btnCls("getSlot", "btn-cal btn-ghost-cal")} onClick={onGetSlot} disabled={isBusy}>
                                {btnLoadingText("getSlot", "Get Slot")}
                            </button>
                            <button type="button" className={btnCls("list", "btn-cal btn-ghost-cal")} onClick={onList} disabled={isBusy}>
                                {btnLoadingText("list", "List All Slots")}
                            </button>
                            <button type="button" className={btnCls("count", "btn-cal btn-ghost-cal")} onClick={onCount} disabled={isBusy}>
                                {btnLoadingText("count", "Get Count")}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Results */}
            <div className="section-card">
                <div className="section-header results-header">
                    <h2>Results</h2>
                </div>
                <div className="section-body" style={{ padding: 0 }}>
                    <div className={`results-output ${outputClass()}`}>
                        <div className="results-bar">Output Stream</div>
                        {output === "Ready." ? (
                            <div className="empty-state">
                                <div className="empty-icon">&#9678;</div>
                                <p>Connect your wallet and perform an action to see results here.</p>
                            </div>
                        ) : (
                            <pre id="output">{output}</pre>
                        )}
                    </div>
                </div>
            </div>
        </main>
    );
}
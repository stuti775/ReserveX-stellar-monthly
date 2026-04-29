import React, { useState, useRef, useCallback, useEffect } from "react";
import "./App.css";
import {
    checkConnection, connectWallet,
    createSlot, bookSlot, cancelBooking, completeBooking,
    updatePrice, deleteSlot,
    getSlot, listSlots, getSlotCount,
    datetimeToTs, tsToDisplay, stroopsToXlm,
} from "../lib/stellar.js";

// ── Helpers ───────────────────────────────────────────────────────────────────
const nowDt = (offsetSeconds = 0) => {
    const d = new Date(Date.now() + offsetSeconds * 1000);
    return d.toISOString().slice(0, 16);
};

const truncate = (addr) =>
    addr && addr.length > 12 ? addr.slice(0, 6) + "…" + addr.slice(-4) : addr;

const STATUS_META = {
    available: { label: "Available", cls: "badge-available" },
    booked:    { label: "Booked",    cls: "badge-booked"    },
    cancelled: { label: "Cancelled", cls: "badge-cancelled" },
    completed: { label: "Completed", cls: "badge-completed" },
};

// ── Toast ─────────────────────────────────────────────────────────────────────
function Toast({ toasts, dismiss }) {
    return (
        <div className="toast-stack">
            {toasts.map(t => (
                <div key={t.id} className={`toast toast-${t.type}`}>
                    <span className="toast-icon">{t.type === "success" ? "✓" : t.type === "error" ? "✕" : "⋯"}</span>
                    <span className="toast-msg">{t.message}</span>
                    <button className="toast-close" onClick={() => dismiss(t.id)}>×</button>
                </div>
            ))}
        </div>
    );
}

// ── Slot Card ─────────────────────────────────────────────────────────────────
function SlotCard({ slot, slotId }) {
    const meta = STATUS_META[slot?.status] || STATUS_META.available;
    return (
        <div className="slot-card">
            <div className="slot-card-header">
                <span className="slot-id">#{String(slotId)}</span>
                <span className={`badge ${meta.cls}`}>{meta.label}</span>
            </div>
            <h3 className="slot-service">{String(slot.service_name || "—")}</h3>
            <dl className="slot-meta">
                <div className="slot-meta-row">
                    <dt>Date</dt>
                    <dd>{tsToDisplay(slot.date)}</dd>
                </div>
                <div className="slot-meta-row">
                    <dt>Start</dt>
                    <dd>{tsToDisplay(slot.start_time)}</dd>
                </div>
                <div className="slot-meta-row">
                    <dt>End</dt>
                    <dd>{tsToDisplay(slot.end_time)}</dd>
                </div>
                <div className="slot-meta-row">
                    <dt>Price</dt>
                    <dd className="slot-price">{stroopsToXlm(slot.price)}</dd>
                </div>
                <div className="slot-meta-row">
                    <dt>Provider</dt>
                    <dd className="addr">{truncate(String(slot.provider))}</dd>
                </div>
                {slot.is_booked && (
                    <div className="slot-meta-row">
                        <dt>Customer</dt>
                        <dd className="addr">{truncate(String(slot.customer))}</dd>
                    </div>
                )}
            </dl>
        </div>
    );
}

// ── Field ─────────────────────────────────────────────────────────────────────
function Field({ label, hint, children }) {
    return (
        <div className="field">
            <label className="field-label">{label}</label>
            {children}
            {hint && <span className="field-hint">{hint}</span>}
        </div>
    );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
    const [walletKey, setWalletKey] = useState("");
    const [activeTab, setActiveTab] = useState("create");
    const [isBusy, setIsBusy] = useState(false);
    const [busyAction, setBusyAction] = useState("");
    const [toasts, setToasts] = useState([]);
    const [slotCount, setSlotCount] = useState("—");
    const [slotIds, setSlotIds] = useState([]);
    const [viewedSlot, setViewedSlot] = useState(null);
    const [viewedSlotId, setViewedSlotId] = useState("");
    const [confirmCancel, setConfirmCancel] = useState(false);
    const confirmTimer = useRef(null);
    const toastId = useRef(0);

    // Forms
    const [createForm, setCreateForm] = useState({
        id: "slot1", serviceName: "Consultation",
        date: nowDt(), startTime: nowDt(3600), endTime: nowDt(7200),
        price: "10000000",
    });
    const [bookForm, setBookForm]     = useState({ id: "slot1" });
    const [actionForm, setActionForm] = useState({ id: "slot1", newPrice: "10000000" });
    const [queryId, setQueryId]       = useState("slot1");

    // ── Toast helpers ─────────────────────────────────────────────────────────
    const addToast = useCallback((message, type = "info") => {
        const id = ++toastId.current;
        setToasts(prev => [...prev, { id, message, type }]);
        setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000);
    }, []);

    const dismissToast = useCallback((id) =>
        setToasts(prev => prev.filter(t => t.id !== id)), []);

    // ── Run action wrapper ────────────────────────────────────────────────────
    const run = useCallback(async (fn, actionKey, successMsg) => {
        setIsBusy(true);
        setBusyAction(actionKey);
        try {
            const result = await fn();
            if (successMsg) addToast(successMsg, "success");
            return result;
        } catch (err) {
            addToast(err?.message || String(err), "error");
            return null;
        } finally {
            setIsBusy(false);
            setBusyAction("");
        }
    }, [addToast]);

    const isLoading = (key) => isBusy && busyAction === key;

    // ── Wallet ────────────────────────────────────────────────────────────────
    const onConnect = async () => {
        const result = await run(async () => {
            const user = await connectWallet();
            if (!user?.publicKey) throw new Error("Could not get wallet address.");
            setWalletKey(user.publicKey);
            setCreateForm(f => ({ ...f }));
            return user.publicKey;
        }, "connect", null);
        if (result) addToast(`Connected: ${truncate(result)}`, "success");
    };

    // Auto-detect on mount
    useEffect(() => {
        checkConnection().then(user => {
            if (user?.publicKey) setWalletKey(user.publicKey);
        });
    }, []);

    // ── Create Slot ───────────────────────────────────────────────────────────
    const onCreateSlot = () => run(async () => {
        const provider = walletKey || createForm.provider;
        if (!provider) throw new Error("Connect your wallet first.");
        await createSlot({
            id: createForm.id.trim(),
            provider,
            serviceName: createForm.serviceName.trim(),
            date:      datetimeToTs(createForm.date),
            startTime: datetimeToTs(createForm.startTime),
            endTime:   datetimeToTs(createForm.endTime),
            price:     Number(createForm.price),
        });
        await refreshCount();
    }, "createSlot", `Slot "${createForm.id}" created successfully.`);

    // ── Book Slot ─────────────────────────────────────────────────────────────
    const onBookSlot = () => run(async () => {
        const customer = walletKey;
        if (!customer) throw new Error("Connect your wallet first.");
        await bookSlot({ id: bookForm.id.trim(), customer });
    }, "bookSlot", `Slot "${bookForm.id}" booked.`);

    // ── Cancel Booking ────────────────────────────────────────────────────────
    const onCancelBooking = useCallback(() => {
        if (confirmCancel) {
            clearTimeout(confirmTimer.current);
            setConfirmCancel(false);
            run(async () => {
                const caller = walletKey;
                if (!caller) throw new Error("Connect your wallet first.");
                await cancelBooking({ id: actionForm.id.trim(), caller });
            }, "cancelBooking", `Booking for "${actionForm.id}" cancelled.`);
        } else {
            setConfirmCancel(true);
            confirmTimer.current = setTimeout(() => setConfirmCancel(false), 4000);
        }
    }, [confirmCancel, actionForm.id, walletKey, run]);

    // ── Complete Booking ──────────────────────────────────────────────────────
    const onComplete = () => run(async () => {
        const provider = walletKey;
        if (!provider) throw new Error("Connect your wallet first.");
        await completeBooking({ id: actionForm.id.trim(), provider });
    }, "completeBooking", `Booking "${actionForm.id}" marked complete.`);

    // ── Update Price ──────────────────────────────────────────────────────────
    const onUpdatePrice = () => run(async () => {
        const provider = walletKey;
        if (!provider) throw new Error("Connect your wallet first.");
        await updatePrice({ id: actionForm.id.trim(), provider, newPrice: Number(actionForm.newPrice) });
    }, "updatePrice", `Price updated for "${actionForm.id}".`);

    // ── Delete Slot ───────────────────────────────────────────────────────────
    const onDeleteSlot = () => run(async () => {
        const provider = walletKey;
        if (!provider) throw new Error("Connect your wallet first.");
        await deleteSlot({ id: actionForm.id.trim(), provider });
        await refreshCount();
    }, "deleteSlot", `Slot "${actionForm.id}" deleted.`);

    // ── Query ─────────────────────────────────────────────────────────────────
    const onGetSlot = () => run(async () => {
        const result = await getSlot(queryId.trim());
        setViewedSlot(result || null);
        setViewedSlotId(queryId.trim());
        if (!result) addToast("Slot not found.", "error");
    }, "getSlot", null);

    const onListSlots = () => run(async () => {
        const ids = await listSlots();
        const arr = Array.isArray(ids) ? ids : [];
        setSlotIds(arr);
        setViewedSlot(null);
        addToast(`Found ${arr.length} slot${arr.length !== 1 ? "s" : ""}.`, "success");
    }, "listSlots", null);

    const refreshCount = async () => {
        const c = await getSlotCount().catch(() => null);
        if (c !== null) setSlotCount(String(c));
    };

    const onGetCount = () => run(async () => {
        const c = await getSlotCount();
        setSlotCount(String(c));
        addToast(`Total slots: ${c}`, "success");
    }, "getCount", null);

    // ── Field helpers ─────────────────────────────────────────────────────────
    const setCreate = (e) => setCreateForm(p => ({ ...p, [e.target.name]: e.target.value }));
    const setBook   = (e) => setBookForm(p => ({ ...p, [e.target.name]: e.target.value }));
    const setAction = (e) => setActionForm(p => ({ ...p, [e.target.name]: e.target.value }));

    const isConnected = walletKey.length > 0;

    const tabs = [
        { id: "create",  label: "Create Slot",   icon: "+" },
        { id: "book",    label: "Book / Manage",  icon: "◈" },
        { id: "query",   label: "Query",          icon: "◉" },
    ];

    return (
        <div className="app">
            <Toast toasts={toasts} dismiss={dismissToast} />

            {/* ── Header ── */}
            <header className="site-header">
                <div className="header-brand">
                    <div className="brand-mark">RX</div>
                    <div>
                        <p className="brand-eyebrow">Stellar · Soroban · Testnet</p>
                        <h1 className="brand-title">ReserveX</h1>
                    </div>
                </div>
                <div className="header-right">
                    <div className="stat-pill">
                        <span className="stat-pill-label">Slots</span>
                        <span className="stat-pill-value">{slotCount}</span>
                    </div>
                    <button
                        id="connectWallet"
                        className={`btn btn-connect ${isConnected ? "btn-connected" : ""}`}
                        onClick={onConnect}
                        disabled={isBusy && busyAction === "connect"}
                    >
                        {isLoading("connect") ? <span className="spinner" /> : null}
                        {isConnected ? (
                            <><span className="dot dot-green" />{truncate(walletKey)}</>
                        ) : (
                            <><span className="dot dot-red" />Connect Freighter</>
                        )}
                    </button>
                </div>
            </header>

            {/* ── Hero Banner ── */}
            <div className="hero-band">
                <div className="hero-copy">
                    <p className="hero-tag">Decentralised Booking</p>
                    <p className="hero-desc">
                        Create service slots, manage bookings and settlements — all enforced on-chain with Soroban smart contracts.
                    </p>
                </div>
                <div className="hero-stats">
                    <div className="hs-item">
                        <span className="hs-num">{slotCount}</span>
                        <span className="hs-label">Total Slots</span>
                    </div>
                    <div className="hs-divider" />
                    <div className="hs-item">
                        <span className={`hs-num hs-status ${isConnected ? "hs-green" : "hs-red"}`}>
                            {isConnected ? "Live" : "Offline"}
                        </span>
                        <span className="hs-label">Wallet</span>
                    </div>
                    <div className="hs-divider" />
                    <div className="hs-item">
                        <span className="hs-num">Testnet</span>
                        <span className="hs-label">Network</span>
                    </div>
                </div>
            </div>

            {/* ── Tab Nav ── */}
            <nav className="tab-nav" role="tablist">
                {tabs.map(t => (
                    <button
                        key={t.id}
                        role="tab"
                        aria-selected={activeTab === t.id}
                        className={`tab-btn ${activeTab === t.id ? "tab-active" : ""}`}
                        onClick={() => setActiveTab(t.id)}
                    >
                        <span className="tab-icon">{t.icon}</span>
                        {t.label}
                    </button>
                ))}
            </nav>

            <main className="workspace">
                {/* ── CREATE ── */}
                {activeTab === "create" && (
                    <section className="panel">
                        <div className="panel-head">
                            <div>
                                <h2 className="panel-title">Create Service Slot</h2>
                                <p className="panel-sub">Publish a new bookable time slot on-chain.</p>
                            </div>
                        </div>
                        <div className="panel-body">
                            <div className="form-grid-2">
                                <Field label="Slot ID" hint="Unique symbol, max 32 chars, no spaces.">
                                    <input className="input" name="id" value={createForm.id} onChange={setCreate} placeholder="e.g. slot1" />
                                </Field>
                                <Field label="Service Name">
                                    <input className="input" name="serviceName" value={createForm.serviceName} onChange={setCreate} placeholder="e.g. Consultation" />
                                </Field>
                                <Field label="Price (stroops)" hint="1 XLM = 10,000,000 stroops">
                                    <input className="input" name="price" type="number" value={createForm.price} onChange={setCreate} />
                                </Field>
                                <Field label="Date">
                                    <input className="input" type="datetime-local" name="date" value={createForm.date} onChange={setCreate} />
                                </Field>
                                <Field label="Start Time">
                                    <input className="input" type="datetime-local" name="startTime" value={createForm.startTime} onChange={setCreate} />
                                </Field>
                                <Field label="End Time">
                                    <input className="input" type="datetime-local" name="endTime" value={createForm.endTime} onChange={setCreate} />
                                </Field>
                            </div>
                            {!isConnected && (
                                <div className="info-bar">Connect your Freighter wallet to sign this transaction.</div>
                            )}
                            <div className="action-row">
                                <button
                                    id="createSlotBtn"
                                    className={`btn btn-primary ${isLoading("createSlot") ? "btn-busy" : ""}`}
                                    onClick={onCreateSlot}
                                    disabled={isBusy}
                                >
                                    {isLoading("createSlot") ? <><span className="spinner" /> Creating…</> : "Create Slot"}
                                </button>
                            </div>
                        </div>
                    </section>
                )}

                {/* ── BOOK / MANAGE ── */}
                {activeTab === "book" && (
                    <div className="col-layout">
                        {/* Book */}
                        <section className="panel">
                            <div className="panel-head">
                                <div>
                                    <h2 className="panel-title">Book a Slot</h2>
                                    <p className="panel-sub">Reserve an available slot as a customer.</p>
                                </div>
                            </div>
                            <div className="panel-body">
                                <Field label="Slot ID">
                                    <input className="input" name="id" value={bookForm.id} onChange={setBook} placeholder="slot1" />
                                </Field>
                                <div className="action-row" style={{ marginTop: "1rem" }}>
                                    <button
                                        id="bookSlotBtn"
                                        className={`btn btn-success ${isLoading("bookSlot") ? "btn-busy" : ""}`}
                                        onClick={onBookSlot}
                                        disabled={isBusy}
                                    >
                                        {isLoading("bookSlot") ? <><span className="spinner" /> Booking…</> : "Book Slot"}
                                    </button>
                                </div>
                            </div>
                        </section>

                        {/* Manage */}
                        <section className="panel">
                            <div className="panel-head">
                                <div>
                                    <h2 className="panel-title">Manage Slot</h2>
                                    <p className="panel-sub">Cancel, complete, reprice, or delete a slot.</p>
                                </div>
                            </div>
                            <div className="panel-body">
                                <div className="form-grid-2">
                                    <Field label="Slot ID" hint="The slot to act on.">
                                        <input className="input" name="id" value={actionForm.id} onChange={setAction} placeholder="slot1" />
                                    </Field>
                                    <Field label="New Price (stroops)" hint="For Update Price only.">
                                        <input className="input" name="newPrice" type="number" value={actionForm.newPrice} onChange={setAction} />
                                    </Field>
                                </div>
                                <div className="action-row action-wrap">
                                    <button
                                        id="cancelBookingBtn"
                                        className={`btn btn-danger ${isLoading("cancelBooking") ? "btn-busy" : ""} ${confirmCancel ? "btn-confirm" : ""}`}
                                        onClick={onCancelBooking}
                                        disabled={isBusy}
                                    >
                                        {isLoading("cancelBooking")
                                            ? <><span className="spinner" /> Cancelling…</>
                                            : confirmCancel ? "⚠ Confirm Cancel?" : "Cancel Booking"}
                                    </button>
                                    <button
                                        id="completeBookingBtn"
                                        className={`btn btn-primary ${isLoading("completeBooking") ? "btn-busy" : ""}`}
                                        onClick={onComplete}
                                        disabled={isBusy}
                                    >
                                        {isLoading("completeBooking") ? <><span className="spinner" /> Completing…</> : "Complete Booking"}
                                    </button>
                                    <button
                                        id="updatePriceBtn"
                                        className={`btn btn-outline ${isLoading("updatePrice") ? "btn-busy" : ""}`}
                                        onClick={onUpdatePrice}
                                        disabled={isBusy}
                                    >
                                        {isLoading("updatePrice") ? <><span className="spinner" /> Updating…</> : "Update Price"}
                                    </button>
                                    <button
                                        id="deleteSlotBtn"
                                        className={`btn btn-ghost-danger ${isLoading("deleteSlot") ? "btn-busy" : ""}`}
                                        onClick={onDeleteSlot}
                                        disabled={isBusy}
                                    >
                                        {isLoading("deleteSlot") ? <><span className="spinner" /> Deleting…</> : "Delete Slot"}
                                    </button>
                                </div>
                            </div>
                        </section>
                    </div>
                )}

                {/* ── QUERY ── */}
                {activeTab === "query" && (
                    <section className="panel">
                        <div className="panel-head">
                            <div>
                                <h2 className="panel-title">Query Blockchain State</h2>
                                <p className="panel-sub">Read slot data directly from the Soroban contract.</p>
                            </div>
                        </div>
                        <div className="panel-body">
                            <div className="query-bar">
                                <Field label="Slot ID">
                                    <input
                                        className="input"
                                        value={queryId}
                                        onChange={e => setQueryId(e.target.value)}
                                        placeholder="slot1"
                                    />
                                </Field>
                                <div className="query-btns">
                                    <button
                                        id="getSlotBtn"
                                        className={`btn btn-primary ${isLoading("getSlot") ? "btn-busy" : ""}`}
                                        onClick={onGetSlot}
                                        disabled={isBusy}
                                    >
                                        {isLoading("getSlot") ? <><span className="spinner" /> Fetching…</> : "Get Slot"}
                                    </button>
                                    <button
                                        id="listSlotsBtn"
                                        className={`btn btn-outline ${isLoading("listSlots") ? "btn-busy" : ""}`}
                                        onClick={onListSlots}
                                        disabled={isBusy}
                                    >
                                        {isLoading("listSlots") ? <><span className="spinner" /> Loading…</> : "List All Slots"}
                                    </button>
                                    <button
                                        id="getCountBtn"
                                        className={`btn btn-outline ${isLoading("getCount") ? "btn-busy" : ""}`}
                                        onClick={onGetCount}
                                        disabled={isBusy}
                                    >
                                        {isLoading("getCount") ? <><span className="spinner" /> Loading…</> : "Get Count"}
                                    </button>
                                </div>
                            </div>

                            {/* Slot card result */}
                            {viewedSlot && (
                                <div className="result-section">
                                    <p className="result-label">Slot Details</p>
                                    <SlotCard slot={viewedSlot} slotId={viewedSlotId} />
                                </div>
                            )}

                            {/* Slot ID list */}
                            {slotIds.length > 0 && (
                                <div className="result-section">
                                    <p className="result-label">All Slot IDs ({slotIds.length})</p>
                                    <div className="id-list">
                                        {slotIds.map((id, i) => (
                                            <button
                                                key={i}
                                                className="id-chip"
                                                onClick={() => { setQueryId(String(id)); }}
                                            >
                                                {String(id)}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {!viewedSlot && slotIds.length === 0 && (
                                <div className="empty-state">
                                    <div className="empty-icon">◎</div>
                                    <p>Enter a Slot ID and hit <strong>Get Slot</strong>, or click <strong>List All Slots</strong> to explore.</p>
                                </div>
                            )}
                        </div>
                    </section>
                )}
            </main>

            <footer className="site-footer">
                <span>ReserveX — Stellar Soroban · Testnet</span>
                <span>Built with Soroban SDK &amp; React</span>
            </footer>
        </div>
    );
}
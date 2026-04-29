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
                    <span className="toast-icon">{t.type === "success" ? "✓" : t.type === "error" ? "✕" : "·"}</span>
                    <span className="toast-msg">{t.message}</span>
                    <button className="toast-close" onClick={() => dismiss(t.id)}>×</button>
                </div>
            ))}
        </div>
    );
}

// ── Slot Card ─────────────────────────────────────────────────────────────────
function SlotCard({ slot, slotId, actions }) {
    const meta = STATUS_META[slot?.status] || STATUS_META.available;
    return (
        <div className="slot-card">
            <div className="slot-card-header">
                <span className="slot-id">ID: {String(slotId)}</span>
                <span className={`badge ${meta.cls}`}>{meta.label}</span>
            </div>
            <h3 className="slot-service">{String(slot.service_name || "—")}</h3>
            <div className="slot-meta-grid">
                <div className="sm-item">
                    <span className="sm-label">Date</span>
                    <span className="sm-value">{tsToDisplay(slot.date).split(', ')[0]}</span>
                </div>
                <div className="sm-item">
                    <span className="sm-label">Time</span>
                    <span className="sm-value">{tsToDisplay(slot.start_time).split(', ')[1]} - {tsToDisplay(slot.end_time).split(', ')[1]}</span>
                </div>
                <div className="sm-item">
                    <span className="sm-label">Price</span>
                    <span className="sm-value slot-price">{stroopsToXlm(slot.price)}</span>
                </div>
                <div className="sm-item">
                    <span className="sm-label">Provider</span>
                    <span className="sm-value addr" title={String(slot.provider)}>{truncate(String(slot.provider))}</span>
                </div>
                {slot.is_booked && (
                    <div className="sm-item sm-full">
                        <span className="sm-label">Customer</span>
                        <span className="sm-value addr" title={String(slot.customer)}>{truncate(String(slot.customer))}</span>
                    </div>
                )}
            </div>
            {actions && (
                <div className="slot-card-actions">
                    {actions}
                </div>
            )}
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
    const [activeTab, setActiveTab] = useState("query");
    const [isBusy, setIsBusy] = useState(false);
    const [busyAction, setBusyAction] = useState("");
    const [toasts, setToasts] = useState([]);
    const [txSuccess, setTxSuccess] = useState(null); // Modal state
    
    // Global State
    const [slotCount, setSlotCount] = useState("—");
    const [allSlots, setAllSlots] = useState([]); // Detailed list of slots
    
    // View State
    const [viewedSlot, setViewedSlot] = useState(null);
    const [viewedSlotId, setViewedSlotId] = useState("");
    
    const [confirmCancel, setConfirmCancel] = useState(false);
    const confirmTimer = useRef(null);
    const toastId = useRef(0);

    // Forms
    const [createForm, setCreateForm] = useState({
        id: "consult-1", serviceName: "Premium Consultation",
        date: nowDt(), startTime: nowDt(3600), endTime: nowDt(7200),
        price: "100", // XLM
    });
    const [bookForm, setBookForm]     = useState({ id: "" });
    const [actionForm, setActionForm] = useState({ id: "", newPrice: "" }); // XLM
    const [queryId, setQueryId]       = useState("");

    // ── Derived Data
    const availableSlots = allSlots.filter(s => !s.data.is_booked && (s.data.status === "available" || !s.data.status));
    const myPublishedSlots = allSlots.filter(s => String(s.data.provider) === walletKey);
    const myBookings = allSlots.filter(s => String(s.data.customer) === walletKey);

    // ── Toast helpers
    const addToast = useCallback((message, type = "info") => {
        const id = ++toastId.current;
        setToasts(prev => [...prev, { id, message, type }]);
        setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000);
    }, []);

    const dismissToast = useCallback((id) =>
        setToasts(prev => prev.filter(t => t.id !== id)), []);

    // ── Run action wrapper
    const run = useCallback(async (fn, actionKey, successMsg) => {
        setIsBusy(true);
        setBusyAction(actionKey);
        try {
            const result = await fn();
            // If result is a transaction hash string (64 hex chars), show the Modal instead of a Toast
            if (successMsg && typeof result === 'string' && result.length === 64) {
                setTxSuccess({
                    message: successMsg,
                    hash: result,
                    link: `https://stellar.expert/explorer/testnet/tx/${result}`
                });
            } else if (successMsg) {
                addToast(successMsg, "success");
            }
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

    // ── Wallet
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

    const onDisconnect = () => {
        setWalletKey("");
        addToast("Wallet disconnected.", "info");
    };

    useEffect(() => {
        checkConnection().then(user => {
            if (user?.publicKey) setWalletKey(user.publicKey);
        });
        refreshCount();
        onListSlots(); 
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── Actions
    const onCreateSlot = () => run(async () => {
        const provider = walletKey || createForm.provider;
        if (!provider) throw new Error("Connect your wallet first.");
        
        const priceInStroops = Math.floor(Number(createForm.price) * 10_000_000);
        
        await createSlot({
            id: createForm.id.trim(),
            provider,
            serviceName: createForm.serviceName.trim(),
            date:      datetimeToTs(createForm.date),
            startTime: datetimeToTs(createForm.startTime),
            endTime:   datetimeToTs(createForm.endTime),
            price:     priceInStroops,
        });
        await refreshCount();
        await onListSlots();
    }, "createSlot", `Slot "${createForm.id}" published successfully.`);

    const onBookSlot = (targetId) => {
        const idToBook = typeof targetId === 'string' ? targetId : bookForm.id;
        return run(async () => {
            const customer = walletKey;
            if (!customer) throw new Error("Connect your wallet first.");
            if (!idToBook.trim()) throw new Error("Slot ID is required.");
            await bookSlot({ id: idToBook.trim(), customer });
            await onListSlots();
        }, "bookSlot", `Reservation confirmed for "${idToBook}".`);
    };

    const onCancelBooking = useCallback((targetId) => {
        const idToCancel = typeof targetId === 'string' ? targetId : actionForm.id;
        if (!idToCancel.trim()) return addToast("Slot ID is required.", "error");

        if (confirmCancel === idToCancel) {
            clearTimeout(confirmTimer.current);
            setConfirmCancel(false);
            run(async () => {
                const caller = walletKey;
                if (!caller) throw new Error("Connect your wallet first.");
                await cancelBooking({ id: idToCancel.trim(), caller });
                await onListSlots();
            }, "cancelBooking", `Booking for "${idToCancel}" cancelled.`);
        } else {
            setConfirmCancel(idToCancel);
            confirmTimer.current = setTimeout(() => setConfirmCancel(false), 4000);
        }
    }, [confirmCancel, actionForm.id, walletKey, run, addToast]);

    const onComplete = (targetId) => {
        const idToComplete = typeof targetId === 'string' ? targetId : actionForm.id;
        return run(async () => {
            const provider = walletKey;
            if (!provider) throw new Error("Connect your wallet first.");
            if (!idToComplete.trim()) throw new Error("Slot ID is required.");
            await completeBooking({ id: idToComplete.trim(), provider });
            await onListSlots();
        }, "completeBooking", `Booking "${idToComplete}" marked complete.`);
    };

    const onUpdatePrice = () => run(async () => {
        const provider = walletKey;
        if (!provider) throw new Error("Connect your wallet first.");
        if (!actionForm.id.trim()) throw new Error("Slot ID is required.");
        if (!actionForm.newPrice) throw new Error("New price is required.");
        const priceInStroops = Math.floor(Number(actionForm.newPrice) * 10_000_000);
        await updatePrice({ id: actionForm.id.trim(), provider, newPrice: priceInStroops });
        await onListSlots();
        setActionForm({ id: "", newPrice: "" });
    }, "updatePrice", `Price updated for "${actionForm.id}".`);

    const onDeleteSlot = (targetId) => {
        const idToDelete = typeof targetId === 'string' ? targetId : actionForm.id;
        return run(async () => {
            const provider = walletKey;
            if (!provider) throw new Error("Connect your wallet first.");
            if (!idToDelete.trim()) throw new Error("Slot ID is required.");
            await deleteSlot({ id: idToDelete.trim(), provider });
            await refreshCount();
            await onListSlots();
        }, "deleteSlot", `Slot "${idToDelete}" deleted.`);
    };

    const onGetSlot = () => run(async () => {
        if (!queryId.trim()) return;
        const result = await getSlot(queryId.trim());
        setViewedSlot(result || null);
        setViewedSlotId(queryId.trim());
        if (!result) addToast("Slot not found.", "error");
    }, "getSlot", null);

    const onListSlots = () => run(async () => {
        const ids = await listSlots();
        const arr = Array.isArray(ids) ? ids : [];
        setViewedSlot(null);
        
        if (arr.length > 0) {
            const details = await Promise.all(arr.map(async id => {
                try {
                    const s = await getSlot(id);
                    return { id, data: s };
                } catch {
                    return null;
                }
            }));
            setAllSlots(details.filter(d => d !== null && d.data));
        } else {
            setAllSlots([]);
        }
    }, "listSlots", null);

    const refreshCount = async () => {
        const c = await getSlotCount().catch(() => null);
        if (c !== null) setSlotCount(String(c));
    };

    // ── Field helpers
    const setCreate = (e) => setCreateForm(p => ({ ...p, [e.target.name]: e.target.value }));
    const setBook   = (e) => setBookForm(p => ({ ...p, [e.target.name]: e.target.value }));
    const setAction = (e) => setActionForm(p => ({ ...p, [e.target.name]: e.target.value }));

    const handleManageClick = (id) => {
        setActionForm({ id, newPrice: "" });
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    const isConnected = walletKey.length > 0;

    return (
        <div className="app-layout">
            <Toast toasts={toasts} dismiss={dismissToast} />

            {/* Transaction Modal */}
            {txSuccess && (
                <div className="modal-overlay">
                    <div className="modal-content fade-in">
                        <button className="modal-close" onClick={() => setTxSuccess(null)}>×</button>
                        <div className="tx-icon">✅</div>
                        <h3 className="tx-title">Transaction Successful</h3>
                        <p className="tx-desc">{txSuccess.message}</p>
                        <div className="tx-status-box">
                            <span className="tx-status-label">Network Status</span>
                            <span className="badge badge-completed">Confirmed</span>
                        </div>
                        <a href={txSuccess.link} target="_blank" rel="noopener noreferrer" className="btn btn-outline tx-btn">
                            View on Stellar Expert ↗
                        </a>
                    </div>
                </div>
            )}

            {/* Sidebar Navigation */}
            <aside className="sidebar">
                <div className="sidebar-header">
                    <h1 className="brand-title">ReserveX.</h1>
                    <p className="brand-subtitle">Stellar Soroban Network</p>
                </div>

                <nav className="side-nav">
                    <div className="nav-group">
                        <span className="nav-group-title">Discover</span>
                        <button
                            className={`nav-item ${activeTab === "query" ? "active" : ""}`}
                            onClick={() => { setActiveTab("query"); onListSlots(); }}
                        >
                            <span className="nav-icon">⌕</span>
                            Network Explorer
                        </button>
                    </div>

                    <div className="nav-group">
                        <span className="nav-group-title">My Operations</span>
                        <button
                            className={`nav-item ${activeTab === "create" ? "active" : ""}`}
                            onClick={() => setActiveTab("create")}
                        >
                            <span className="nav-icon">⨁</span>
                            Publish Slot
                        </button>
                        <button
                            className={`nav-item ${activeTab === "book" ? "active" : ""}`}
                            onClick={() => { setActiveTab("book"); onListSlots(); }}
                        >
                            <span className="nav-icon">⚲</span>
                            Reservations
                        </button>
                        <button
                            className={`nav-item ${activeTab === "manage" ? "active" : ""}`}
                            onClick={() => { setActiveTab("manage"); onListSlots(); }}
                        >
                            <span className="nav-icon">⛭</span>
                            Management
                        </button>
                    </div>
                </nav>

                <div className="sidebar-footer">
                    <div className="stat-box">
                        <span className="stat-label">Total Published Slots</span>
                        <span className="stat-value">{slotCount}</span>
                    </div>
                    
                    {isConnected ? (
                        <div className="wallet-card">
                            <div className="wallet-info">
                                <span className="dot dot-green" />
                                <span className="wallet-addr">{truncate(walletKey)}</span>
                            </div>
                            <button className="btn-disconnect" onClick={onDisconnect}>
                                Disconnect Wallet
                            </button>
                        </div>
                    ) : (
                        <button
                            className={`btn-connect`}
                            onClick={onConnect}
                            disabled={isBusy && busyAction === "connect"}
                        >
                            {isLoading("connect") ? <span className="spinner" /> : null}
                            <span className="dot dot-amber" /> Connect Freighter
                        </button>
                    )}
                </div>
            </aside>

            {/* Main Content Area */}
            <main className="main-content">
                <div className="content-wrapper">
                    
                    {/* ── EXPLORE (Dashboard) ── */}
                    {activeTab === "query" && (
                        <section className="view-section fade-in">
                            <header className="view-header">
                                <h2 className="view-title">Network Explorer</h2>
                                <p className="view-description">Browse and query real-time service slot availability directly from the Soroban smart contracts.</p>
                            </header>
                            
                            <div className="explore-toolbar card">
                                <div className="search-group">
                                    <input 
                                        className="input search-input" 
                                        value={queryId} 
                                        onChange={e => setQueryId(e.target.value)} 
                                        placeholder="Search by specific Slot ID (e.g. consult-1)" 
                                    />
                                    <button className="btn btn-primary" onClick={onGetSlot} disabled={isBusy || !queryId}>
                                        {isLoading("getSlot") ? <span className="spinner" /> : null}
                                        Search
                                    </button>
                                </div>
                                <div className="divider-vert"></div>
                                <button className="btn btn-outline" onClick={onListSlots} disabled={isBusy}>
                                    {isLoading("listSlots") ? <span className="spinner" /> : null}
                                    Refresh Registry
                                </button>
                            </div>

                            <div className="results-area">
                                {viewedSlot && (
                                    <div className="result-block">
                                        <div className="flex-between">
                                            <h3 className="result-title">Search Result</h3>
                                            <button className="btn-text" onClick={() => setViewedSlot(null)}>Clear</button>
                                        </div>
                                        <SlotCard slot={viewedSlot} slotId={viewedSlotId} />
                                    </div>
                                )}

                                {!viewedSlot && allSlots.length > 0 && (
                                    <div className="result-block">
                                        <h3 className="result-title">Recent Network Activity</h3>
                                        <div className="slots-grid">
                                            {allSlots.map((s, i) => (
                                                <SlotCard key={i} slot={s.data} slotId={s.id} />
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {!viewedSlot && allSlots.length === 0 && (
                                    <div className="empty-state">
                                        <span className="empty-icon">◎</span>
                                        <p>No slots found on the network. Be the first to publish a service!</p>
                                    </div>
                                )}
                            </div>
                        </section>
                    )}

                    {/* ── CREATE ── */}
                    {activeTab === "create" && (
                        <section className="view-section fade-in">
                            <header className="view-header">
                                <h2 className="view-title">Publish Slot</h2>
                                <p className="view-description">Offer your service or time on the decentralized ledger.</p>
                            </header>
                            
                            <div className="card">
                                <div className="form-grid-2">
                                    <Field label="Slot Identifier" hint="Unique identifier, max 32 chars.">
                                        <input className="input" name="id" value={createForm.id} onChange={setCreate} placeholder="e.g. consult-1" />
                                    </Field>
                                    <Field label="Service Title">
                                        <input className="input" name="serviceName" value={createForm.serviceName} onChange={setCreate} placeholder="e.g. Legal Consultation" />
                                    </Field>
                                    <Field label="Price (XLM)" hint="Enter price directly in XLM.">
                                        <input className="input" name="price" type="number" step="0.1" min="0" value={createForm.price} onChange={setCreate} />
                                    </Field>
                                    <Field label="Date">
                                        <input className="input" type="date" name="date" value={createForm.date.split('T')[0]} onChange={(e) => setCreate({ target: { name: 'date', value: e.target.value + 'T00:00' } })} />
                                    </Field>
                                    <Field label="Start Time">
                                        <input className="input" type="time" name="startTime" value={createForm.startTime.split('T')[1]} onChange={(e) => setCreate({ target: { name: 'startTime', value: createForm.date.split('T')[0] + 'T' + e.target.value } })} />
                                    </Field>
                                    <Field label="End Time">
                                        <input className="input" type="time" name="endTime" value={createForm.endTime.split('T')[1]} onChange={(e) => setCreate({ target: { name: 'endTime', value: createForm.date.split('T')[0] + 'T' + e.target.value } })} />
                                    </Field>
                                </div>
                                {!isConnected && (
                                    <div className="alert-box">Please connect your Freighter wallet to authorize this transaction.</div>
                                )}
                                <div className="action-row mt-6">
                                    <button className="btn btn-primary" onClick={onCreateSlot} disabled={isBusy}>
                                        {isLoading("createSlot") ? <span className="spinner" /> : null}
                                        Publish to Network
                                    </button>
                                </div>
                            </div>
                        </section>
                    )}

                    {/* ── BOOK ── */}
                    {activeTab === "book" && (
                        <section className="view-section fade-in">
                            <header className="view-header">
                                <h2 className="view-title">Reservations</h2>
                                <p className="view-description">Secure an available slot securely on-chain.</p>
                            </header>

                            {/* Quick Book Form */}
                            <div className="card">
                                <h3 className="result-title" style={{ fontSize: "16px" }}>Quick Reservation</h3>
                                <div className="form-grid-2">
                                    <Field label="Target Slot ID" hint="Enter the ID if you already know it.">
                                        <input className="input" name="id" value={bookForm.id} onChange={setBook} placeholder="e.g. consult-1" />
                                    </Field>
                                </div>
                                <div className="action-row mt-6">
                                    <button className="btn btn-primary" onClick={onBookSlot} disabled={isBusy || !isConnected}>
                                        {isLoading("bookSlot") ? <span className="spinner" /> : null}
                                        Confirm Reservation
                                    </button>
                                    {!isConnected && <span className="field-hint">Connect wallet to book.</span>}
                                </div>
                            </div>

                            {/* Available Slots List */}
                            <div className="result-block">
                                <h3 className="result-title">Available Network Slots</h3>
                                {availableSlots.length > 0 ? (
                                    <div className="slots-grid">
                                        {availableSlots.map(s => (
                                            <SlotCard 
                                                key={s.id} 
                                                slot={s.data} 
                                                slotId={s.id} 
                                                actions={
                                                    <button 
                                                        className="btn btn-primary" 
                                                        onClick={() => onBookSlot(s.id)}
                                                        disabled={isBusy || !isConnected}
                                                    >
                                                        Book This Slot
                                                    </button>
                                                }
                                            />
                                        ))}
                                    </div>
                                ) : (
                                    <div className="empty-state" style={{ minHeight: "150px", padding: "2rem" }}>
                                        <span className="empty-icon" style={{ fontSize: "24px" }}>◎</span>
                                        <p>No available slots found on the network at the moment.</p>
                                    </div>
                                )}
                            </div>
                        </section>
                    )}

                    {/* ── MANAGE ── */}
                    {activeTab === "manage" && (
                        <section className="view-section fade-in">
                            <header className="view-header">
                                <h2 className="view-title">Management Dashboard</h2>
                                <p className="view-description">Control the lifecycle of your published slots and reservations.</p>
                            </header>

                            {/* Management Actions Form (Top) */}
                            <div className="card" style={{ border: actionForm.id ? "1px solid var(--primary)" : "1px solid var(--border)" }}>
                                <h3 className="result-title" style={{ fontSize: "16px" }}>
                                    {actionForm.id ? `Managing: ${actionForm.id}` : "Select a slot below to manage"}
                                </h3>
                                <div className="form-grid-2">
                                    <Field label="Target Slot ID">
                                        <input className="input" name="id" value={actionForm.id} onChange={setAction} placeholder="e.g. consult-1" />
                                    </Field>
                                    <Field label="New Price (XLM)" hint="Required only if updating the price.">
                                        <input className="input" name="newPrice" type="number" step="0.1" min="0" value={actionForm.newPrice} onChange={setAction} />
                                    </Field>
                                </div>
                                <div className="action-grid mt-6">
                                    <button className={`btn ${confirmCancel === actionForm.id ? 'btn-danger' : 'btn-outline'}`} onClick={() => onCancelBooking(actionForm.id)} disabled={isBusy || !actionForm.id}>
                                        {isLoading("cancelBooking") ? <span className="spinner" /> : null}
                                        {confirmCancel === actionForm.id ? "Confirm Cancellation" : "Cancel Booking"}
                                    </button>
                                    <button className="btn btn-outline" onClick={() => onComplete(actionForm.id)} disabled={isBusy || !actionForm.id}>
                                        {isLoading("completeBooking") ? <span className="spinner" /> : null}
                                        Mark Completed
                                    </button>
                                    <button className="btn btn-outline" onClick={onUpdatePrice} disabled={isBusy || !actionForm.id}>
                                        {isLoading("updatePrice") ? <span className="spinner" /> : null}
                                        Update Price
                                    </button>
                                    <button className="btn btn-text-danger" onClick={() => onDeleteSlot(actionForm.id)} disabled={isBusy || !actionForm.id}>
                                        {isLoading("deleteSlot") ? <span className="spinner" /> : null}
                                        Delete Slot
                                    </button>
                                </div>
                            </div>

                            {/* My Published Slots */}
                            <div className="result-block">
                                <h3 className="result-title">My Published Slots</h3>
                                {myPublishedSlots.length > 0 ? (
                                    <div className="slots-grid">
                                        {myPublishedSlots.map(s => (
                                            <SlotCard 
                                                key={s.id} 
                                                slot={s.data} 
                                                slotId={s.id} 
                                                actions={
                                                    <button 
                                                        className="btn btn-outline" 
                                                        onClick={() => handleManageClick(s.id)}
                                                    >
                                                        Manage
                                                    </button>
                                                }
                                            />
                                        ))}
                                    </div>
                                ) : (
                                    <div className="empty-state" style={{ minHeight: "100px", padding: "1.5rem" }}>
                                        <p>You have not published any slots.</p>
                                    </div>
                                )}
                            </div>

                            {/* My Bookings */}
                            <div className="result-block">
                                <h3 className="result-title">My Active Bookings</h3>
                                {myBookings.length > 0 ? (
                                    <div className="slots-grid">
                                        {myBookings.map(s => (
                                            <SlotCard 
                                                key={s.id} 
                                                slot={s.data} 
                                                slotId={s.id} 
                                                actions={
                                                    <button 
                                                        className={`btn ${confirmCancel === s.id ? 'btn-danger' : 'btn-outline'}`} 
                                                        onClick={() => onCancelBooking(s.id)}
                                                        disabled={isBusy}
                                                    >
                                                        {confirmCancel === s.id ? "Confirm Cancel" : "Cancel Reservation"}
                                                    </button>
                                                }
                                            />
                                        ))}
                                    </div>
                                ) : (
                                    <div className="empty-state" style={{ minHeight: "100px", padding: "1.5rem" }}>
                                        <p>You do not have any active reservations.</p>
                                    </div>
                                )}
                            </div>

                        </section>
                    )}

                </div>
            </main>
        </div>
    );
}
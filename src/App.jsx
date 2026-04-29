import React, { useMemo, useState } from "react";
import "./App.css";
import { checkConnection, addProduct, updateStock, updatePrice, discontinueProduct, getProduct, listProducts, getLowStock, getTotalValue } from "../lib/stellar.js";


const initialForm = () => ({
    id: "prod1",
    owner: "",
    name: "Sample Product",
    sku: "SKU-001",
    quantity: "10",
    unitPrice: "1000",
    category: "general",
    quantityChange: "5",
    isAddition: true,
    newPrice: "1500",
    lowStockThreshold: "5",
});

const safeStringify = (value) => {
    if (typeof value === "string") return value;
    return JSON.stringify(value, (_key, current) => {
        if (typeof current === "bigint") return current.toString();
        return current;
    }, 2);
};

const toOutput = (value) => {
    if (value == null) return "No data found";
    if (typeof value === "string") return value;
    return safeStringify(value);
};

const truncateAddr = (addr) => addr ? addr.slice(0, 8) + "..." + addr.slice(-4) : "";

const parseNumericField = (value, fieldName) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`${fieldName} must be a valid non-negative number`);
    }
    return parsed;
};

const stroopsToXlm = (value) => {
    try {
        const raw = typeof value === "bigint" ? value : BigInt(value || 0);
        const sign = raw < 0n ? "-" : "";
        const absolute = raw < 0n ? -raw : raw;
        const whole = absolute / 10000000n;
        const fraction = String(absolute % 10000000n).padStart(7, "0").replace(/0+$/, "");
        return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
    } catch {
        return String(value);
    }
};

const buildWriteSummary = (actionName, txResult) => {
    const status = txResult?.status || "PENDING";
    const hash = txResult?.hash || txResult?.id || "N/A";
    return {
        type: "write",
        action: actionName,
        status,
        hash,
        ledger: txResult?.ledger ?? "N/A",
        result: txResult?.resultMetaXdr ? "Transaction confirmed" : "Submitted",
    };
};

const toFriendlyResult = (actionName, result) => {
    if (actionName === "getTotalValue") {
        return {
            totalValueStroops: typeof result === "bigint" ? result.toString() : String(result),
            totalValueXLM: stroopsToXlm(result),
        };
    }

    if (actionName === "listProducts" || actionName === "getLowStock") {
        const ids = Array.isArray(result) ? result : [];
        return {
            count: ids.length,
            ids,
        };
    }

    if (actionName === "getProduct") {
        if (!result) return "Product not found";
        return result;
    }

    return result;
};

const actionLabels = {
    connect: "Connect Wallet",
    addProduct: "Add Product",
    updateStock: "Update Stock",
    updatePrice: "Update Price",
    discontinue: "Discontinue Product",
    getProduct: "Get Product",
    listProducts: "List Products",
    getLowStock: "Low Stock Query",
    getTotalValue: "Total Value Query",
};

export default function App() {
    const [form, setForm] = useState(initialForm);
    const [output, setOutput] = useState("Ready.");
    const [walletState, setWalletState] = useState(null);
    const [isBusy, setIsBusy] = useState(false);
    const [loadingAction, setLoadingAction] = useState(null);
    const [status, setStatus] = useState("idle");
    const [activeTab, setActiveTab] = useState("add");
    const [confirmAction, setConfirmAction] = useState(null);
    const [notice, setNotice] = useState({ type: "info", message: "Connect Freighter to begin." });
    const [history, setHistory] = useState([]);

    const hasWallet = Boolean(walletState);

    const dashboardStats = useMemo(() => {
        return [
            { label: "Wallet", value: hasWallet ? "Connected" : "Disconnected" },
            { label: "Active Product", value: form.id || "-" },
            { label: "Owner", value: form.owner ? truncateAddr(form.owner) : "-" },
            { label: "Low Stock Alert", value: form.lowStockThreshold || "0" },
        ];
    }, [hasWallet, form.id, form.owner, form.lowStockThreshold]);

    const setField = (event) => {
        const { name, value, type, checked } = event.target;
        setForm((prev) => ({ ...prev, [name]: type === "checkbox" ? checked : value }));
    };

    const pushHistory = (entry) => {
        setHistory((prev) => [entry, ...prev].slice(0, 7));
    };

    const runAction = async (actionName, action) => {
        setIsBusy(true);
        setLoadingAction(actionName);
        setStatus("idle");
        try {
            const rawResult = await action();
            const friendlyResult = toFriendlyResult(actionName, rawResult);
            setOutput(toOutput(friendlyResult));
            setStatus("success");
            setNotice({ type: "success", message: `${actionLabels[actionName] || actionName} completed successfully.` });
            pushHistory({
                action: actionLabels[actionName] || actionName,
                state: "success",
                time: new Date().toLocaleTimeString(),
            });
        } catch (error) {
            setOutput(error?.message || String(error));
            setStatus("error");
            setNotice({ type: "error", message: error?.message || "Action failed" });
            pushHistory({
                action: actionLabels[actionName] || actionName,
                state: "error",
                time: new Date().toLocaleTimeString(),
            });
        } finally {
            setIsBusy(false);
            setLoadingAction(null);
        }
    };

    const handleDestructive = (actionName, fn) => {
        if (confirmAction === actionName) {
            setConfirmAction(null);
            fn();
        } else {
            setConfirmAction(actionName);
            setTimeout(() => setConfirmAction(null), 3000);
        }
    };

    const onConnect = () => runAction("connect", async () => {
        const user = await checkConnection();
        if (user) {
            setWalletState(user.publicKey);
            setForm((prev) => ({ ...prev, owner: user.publicKey }));
            setNotice({ type: "success", message: "Wallet connected. Owner has been auto-filled." });
        } else {
            setWalletState(null);
            setNotice({ type: "error", message: "Wallet not connected. Open Freighter and try again." });
        }
        return user ? `Connected: ${user.publicKey}` : "Wallet: not connected";
    });

    const validateCommon = () => {
        if (!form.id.trim()) throw new Error("Product ID is required");
        if (!form.owner.trim()) throw new Error("Owner address is required");
        if (!form.owner.trim().startsWith("G")) {
            throw new Error("Owner address should start with G");
        }
    };

    const onAddProduct = () => runAction("addProduct", async () => {
        validateCommon();
        if (!form.name.trim()) throw new Error("Product name is required");
        parseNumericField(form.quantity, "Quantity");
        parseNumericField(form.unitPrice, "Unit price");

        const result = await addProduct({
            id: form.id.trim(),
            owner: form.owner.trim(),
            name: form.name.trim(),
            sku: form.sku.trim(),
            quantity: form.quantity.trim(),
            unitPrice: form.unitPrice.trim(),
            category: form.category.trim() || "general",
        });

        return buildWriteSummary("addProduct", result);
    });

    const onUpdateStock = () => runAction("updateStock", async () => {
        validateCommon();
        const qty = parseNumericField(form.quantityChange, "Quantity change");
        if (qty <= 0) throw new Error("Quantity change must be greater than zero");

        const result = await updateStock({
            id: form.id.trim(),
            owner: form.owner.trim(),
            quantityChange: form.quantityChange.trim(),
            isAddition: form.isAddition,
        });

        return buildWriteSummary("updateStock", result);
    });

    const onUpdatePrice = () => runAction("updatePrice", async () => {
        validateCommon();
        parseNumericField(form.newPrice, "New price");

        const result = await updatePrice({
            id: form.id.trim(),
            owner: form.owner.trim(),
            newPrice: form.newPrice.trim(),
        });

        return buildWriteSummary("updatePrice", result);
    });

    const onDiscontinue = () => runAction("discontinue", async () => {
        validateCommon();
        const result = await discontinueProduct({
            id: form.id.trim(),
            owner: form.owner.trim(),
        });

        return buildWriteSummary("discontinue", result);
    });

    const onGetProduct = () => runAction("getProduct", async () => getProduct(form.id.trim()));
    const onListProducts = () => runAction("listProducts", async () => listProducts());
    const onGetLowStock = () => runAction("getLowStock", async () => {
        parseNumericField(form.lowStockThreshold, "Low stock threshold");
        return getLowStock(form.lowStockThreshold.trim());
    });
    const onGetTotalValue = () => runAction("getTotalValue", async () => getTotalValue());

    const btnClass = (actionName, base) =>
        `${base}${loadingAction === actionName ? " btn-loading" : ""}`;

    const tabs = [
        { key: "add", label: "Add Product" },
        { key: "stock", label: "Stock & Price" },
        { key: "queries", label: "Queries" },
    ];

    return (
        <main className="app">
            <header className="top-shell">
                <section className="hero">
                    <p className="kicker">Soroban Inventory Console</p>
                    <h1>Smart Contract Operations</h1>
                    <p className="subtitle">
                        Production-style interface for your contract: create products, update stock and price,
                        track low inventory, and monitor total value.
                    </p>
                </section>

                <div className="wallet-panel">
                    <div className="wallet-head">
                        <span className={`status-dot ${walletState ? "connected" : "disconnected"}`}></span>
                        <p className="wallet-title">Wallet</p>
                    </div>
                    <p className="wallet-line">
                        {walletState ? `Connected: ${truncateAddr(walletState)}` : "Not connected"}
                    </p>
                    <button type="button" className={btnClass("connect", "btn btn-connect")} onClick={onConnect} disabled={isBusy}>
                        {walletState ? "Refresh Connection" : "Connect Freighter"}
                    </button>
                    {walletState && (
                        <button
                            type="button"
                            className="btn btn-subtle"
                            disabled={isBusy}
                            onClick={() => setForm((prev) => ({ ...prev, owner: walletState }))}
                        >
                            Use Connected Address
                        </button>
                    )}
                </div>
            </header>

            <section className="stats-grid" aria-label="Dashboard summary">
                {dashboardStats.map((stat) => (
                    <article key={stat.label} className="stat-card">
                        <p className="stat-label">{stat.label}</p>
                        <p className="stat-value">{stat.value}</p>
                    </article>
                ))}
            </section>

            <section className={`notice notice-${notice.type}`}>
                <p>{notice.message}</p>
            </section>

            <div className="workspace-grid">
                <section className="panel panel-main">
                    <nav className="tab-nav" aria-label="Action groups">
                        {tabs.map((t) => (
                            <button
                                key={t.key}
                                type="button"
                                className={`tab-btn${activeTab === t.key ? " active" : ""}`}
                                onClick={() => setActiveTab(t.key)}
                            >
                                {t.label}
                            </button>
                        ))}
                    </nav>

                    {activeTab === "add" && (
                        <section className="card">
                            <div className="card-header">
                                <h2>Add Product</h2>
                                <p>Create a new product entry on-chain.</p>
                            </div>
                            <div className="form-grid cols-2">
                                <div className="form-group">
                                    <label htmlFor="entryId">Product ID</label>
                                    <input id="entryId" name="id" value={form.id} onChange={setField} maxLength={32} />
                                    <span className="helper">Contract key symbol, keep short and unique</span>
                                </div>
                                <div className="form-group">
                                    <label htmlFor="owner">Owner Address</label>
                                    <input id="owner" name="owner" value={form.owner} onChange={setField} placeholder="G..." />
                                    <span className="helper">Stellar public key</span>
                                </div>
                                <div className="form-group">
                                    <label htmlFor="name">Product Name</label>
                                    <input id="name" name="name" value={form.name} onChange={setField} />
                                </div>
                                <div className="form-group">
                                    <label htmlFor="sku">SKU</label>
                                    <input id="sku" name="sku" value={form.sku} onChange={setField} />
                                </div>
                                <div className="form-group">
                                    <label htmlFor="quantity">Quantity</label>
                                    <input id="quantity" name="quantity" value={form.quantity} onChange={setField} type="number" min="0" />
                                    <span className="helper">u32 value</span>
                                </div>
                                <div className="form-group">
                                    <label htmlFor="unitPrice">Unit Price (stroops)</label>
                                    <input id="unitPrice" name="unitPrice" value={form.unitPrice} onChange={setField} type="number" min="0" />
                                    <span className="helper">i128 value</span>
                                </div>
                                <div className="form-group">
                                    <label htmlFor="category">Category Symbol</label>
                                    <input id="category" name="category" value={form.category} onChange={setField} />
                                </div>
                            </div>
                            <div className="actions">
                                <button type="button" className={btnClass("addProduct", "btn btn-primary")} onClick={onAddProduct} disabled={isBusy}>Add Product</button>
                                <button type="button" className={btnClass("getProduct", "btn btn-outline")} onClick={onGetProduct} disabled={isBusy}>Get Product</button>
                                <button type="button" className={btnClass("listProducts", "btn btn-outline")} onClick={onListProducts} disabled={isBusy}>List Products</button>
                            </div>
                        </section>
                    )}

                    {activeTab === "stock" && (
                        <section className="card stock-card">
                            <div className="card-header">
                                <h2>Stock & Price Control</h2>
                                <p>Owner-signed updates for inventory and pricing.</p>
                            </div>
                            <div className="form-grid cols-3">
                                <div className="form-group">
                                    <label htmlFor="quantityChange">Quantity Change</label>
                                    <input id="quantityChange" name="quantityChange" value={form.quantityChange} onChange={setField} type="number" min="0" />
                                </div>
                                <div className="checkbox-row">
                                    <input type="checkbox" id="isAddition" name="isAddition" checked={form.isAddition} onChange={setField} />
                                    <span>{form.isAddition ? "Addition mode" : "Removal mode"}</span>
                                </div>
                                <div className="form-group">
                                    <label htmlFor="newPrice">New Price (stroops)</label>
                                    <input id="newPrice" name="newPrice" value={form.newPrice} onChange={setField} type="number" min="0" />
                                </div>
                            </div>
                            <div className="actions">
                                <button type="button" className={btnClass("updateStock", "btn btn-primary")} onClick={onUpdateStock} disabled={isBusy}>Update Stock</button>
                                <button type="button" className={btnClass("updatePrice", "btn btn-outline")} onClick={onUpdatePrice} disabled={isBusy}>Update Price</button>
                                <button
                                    type="button"
                                    className={btnClass("discontinue", `btn btn-danger-outline${confirmAction === "discontinue" ? " btn-confirm-pulse" : ""}`)}
                                    onClick={() => handleDestructive("discontinue", onDiscontinue)}
                                    disabled={isBusy}
                                >
                                    {confirmAction === "discontinue" ? "Click Again To Confirm" : "Discontinue Product"}
                                </button>
                            </div>
                        </section>
                    )}

                    {activeTab === "queries" && (
                        <section className="card">
                            <div className="card-header">
                                <h2>Read Queries</h2>
                                <p>Inspect current state without writing on-chain.</p>
                            </div>
                            <div className="queries-grid">
                                <div className="query-item">
                                    <div className="form-group">
                                        <label htmlFor="lowStockThreshold">Low Stock Threshold</label>
                                        <input id="lowStockThreshold" name="lowStockThreshold" value={form.lowStockThreshold} onChange={setField} type="number" min="0" />
                                    </div>
                                    <button type="button" className={btnClass("getLowStock", "btn btn-outline")} onClick={onGetLowStock} disabled={isBusy}>Get Low Stock</button>
                                </div>
                                <div className="query-item">
                                    <p className="helper helper-strong">Total inventory value includes only non-discontinued products.</p>
                                    <button type="button" className={btnClass("getTotalValue", "btn btn-outline")} onClick={onGetTotalValue} disabled={isBusy}>Get Total Value</button>
                                </div>
                            </div>
                        </section>
                    )}
                </section>

                <aside className="panel panel-side">
                    <section className="output-terminal">
                        <div className="terminal-bar">
                            <span className="terminal-dot red"></span>
                            <span className="terminal-dot yellow"></span>
                            <span className="terminal-dot green"></span>
                            <span className="terminal-title">latest-result.json</span>
                        </div>
                        <div className={`terminal-body output-${status}`}>
                            {output === "Ready." ? (
                                <p className="empty-state">Run any action to see decoded results here.</p>
                            ) : (
                                <pre id="output">{output}</pre>
                            )}
                        </div>
                    </section>

                    <section className="activity-card">
                        <div className="card-header card-header-compact">
                            <h2>Recent Activity</h2>
                        </div>
                        {history.length === 0 ? (
                            <p className="empty-state">No actions yet.</p>
                        ) : (
                            <ul className="history-list">
                                {history.map((entry, index) => (
                                    <li key={`${entry.action}-${entry.time}-${index}`} className="history-item">
                                        <span className={`history-pill ${entry.state}`}>{entry.state}</span>
                                        <span className="history-action">{entry.action}</span>
                                        <span className="history-time">{entry.time}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>
                </aside>
            </div>
        </main>
    );
}

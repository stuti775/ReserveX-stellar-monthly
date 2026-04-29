import { isAllowed, requestAccess, signTransaction } from "@stellar/freighter-api";
import {
    Account,
    Address,
    Contract,
    Networks,
    rpc,
    TransactionBuilder,
    nativeToScVal,
    scValToNative,
    xdr,
} from "@stellar/stellar-sdk";

// ── Configuration ─────────────────────────────────────────────────────────────
// Replace these with your deployed contract ID and a funded testnet account.
export const CONTRACT_ID = "CAXEPLZA3LYCB3HPAW2A7FF5V5LWDNDS5LKQUXQNZ6OH63SLER3Q5GWD";
export const DEMO_ADDR   = "GB5MDOU5YDHWF3H5TK425XI2BTOZX5CYWXX45D4OVYMLMYSVUQZI7DZ7";

const RPC_URL            = "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = Networks.TESTNET;

const server = new rpc.Server(RPC_URL, { allowHttp: false });

// ── XDR Helpers ───────────────────────────────────────────────────────────────
const toSymbol = (value) => xdr.ScVal.scvSymbol(String(value));
const toI128   = (value) => nativeToScVal(BigInt(value || 0), { type: "i128" });
const toU64    = (value) => nativeToScVal(BigInt(value || 0), { type: "u64" });

// ── Config Guard ─────────────────────────────────────────────────────────────
const requireConfig = () => {
    if (!CONTRACT_ID) throw new Error("CONTRACT_ID is not set in lib/stellar.js");
    if (!DEMO_ADDR)   throw new Error("DEMO_ADDR is not set in lib/stellar.js");
};

// ── Error Parser ─────────────────────────────────────────────────────────────
const ERROR_MAP = {
    1: "Invalid service name (must be non-empty).",
    2: "Invalid time range (start must be before end).",
    3: "Slot not found.",
    4: "Slot already exists with that ID.",
    5: "Slot is already booked.",
    6: "Slot is not currently booked.",
    7: "Unauthorized — you are not the provider or customer for this slot.",
    8: "Invalid status transition.",
    9: "Invalid price (must be ≥ 0).",
};

const parseError = (err) => {
    const msg = err?.message || String(err);
    // Try to pull out contract error code
    const codeMatch = msg.match(/Error\(Contract,\s*#(\d+)\)/);
    if (codeMatch) {
        const code = parseInt(codeMatch[1], 10);
        return ERROR_MAP[code] || `Contract error #${code}`;
    }
    // Freighter / SDK errors
    if (msg.includes("User declined")) return "Transaction cancelled — you declined in Freighter.";
    if (msg.includes("not connected"))  return "Freighter wallet is not connected. Please install and connect it.";
    if (msg.includes("Timed out"))      return "Transaction timed out. The network may be congested.";
    return msg;
};

// ── Wallet ────────────────────────────────────────────────────────────────────

/**
 * Check if Freighter is allowed and return the public key.
 * Returns `{ publicKey: string }` or `null`.
 */
export const checkConnection = async () => {
    try {
        const allowed = await isAllowed();
        if (!allowed) return null;
        const result = await requestAccess();
        if (!result) return null;
        const address =
            result && typeof result === "object" && result.address
                ? result.address
                : result;
        if (!address || typeof address !== "string") return null;
        return { publicKey: address };
    } catch {
        return null;
    }
};

/**
 * Actively prompt the user to connect Freighter.
 * Returns `{ publicKey: string }` or throws.
 */
export const connectWallet = async () => {
    const result = await requestAccess();
    if (!result) throw new Error("Freighter did not return an address.");
    const address =
        result && typeof result === "object" && result.address
            ? result.address
            : result;
    if (!address || typeof address !== "string")
        throw new Error("Could not read address from Freighter.");
    return { publicKey: address };
};

// ── Transaction Helpers ───────────────────────────────────────────────────────

const waitForTx = async (hash, attempts = 0) => {
    const tx = await server.getTransaction(hash);
    if (tx.status === "SUCCESS") return tx;
    if (tx.status === "FAILED")  throw new Error("Transaction failed on-chain.");
    if (attempts > 40)           throw new Error("Timed out waiting for transaction confirmation.");
    await new Promise((r) => setTimeout(r, 2000));
    return waitForTx(hash, attempts + 1);
};

const invokeWrite = async (method, args = []) => {
    if (!CONTRACT_ID) throw new Error("CONTRACT_ID is not set in lib/stellar.js");

    const user = await checkConnection();
    if (!user) throw new Error("Freighter wallet is not connected.");

    const account = await server.getAccount(user.publicKey);
    let tx = new TransactionBuilder(account, {
        fee: "10000",
        networkPassphrase: NETWORK_PASSPHRASE,
    })
        .addOperation(new Contract(CONTRACT_ID).call(method, ...args))
        .setTimeout(30)
        .build();

    tx = await server.prepareTransaction(tx);

    const signed = await signTransaction(tx.toXDR(), {
        networkPassphrase: NETWORK_PASSPHRASE,
    });
    if (!signed || signed.error)
        throw new Error(signed?.error || "Transaction signing failed or was rejected.");

    const signedTxXdr =
        typeof signed === "string" ? signed : signed.signedTxXdr;

    const sent = await server.sendTransaction(
        TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASE)
    );

    if (sent.status === "ERROR") {
        throw new Error(
            parseError({ message: sent.errorResultXdr || "Transaction rejected by network." })
        );
    }

    return waitForTx(sent.hash);
};

const invokeRead = async (method, args = []) => {
    requireConfig();

    const tx = new TransactionBuilder(new Account(DEMO_ADDR, "0"), {
        fee: "100",
        networkPassphrase: NETWORK_PASSPHRASE,
    })
        .addOperation(new Contract(CONTRACT_ID).call(method, ...args))
        .setTimeout(0)
        .build();

    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationSuccess(sim)) {
        return scValToNative(sim.result.retval);
    }

    throw new Error(parseError({ message: sim.error || `Read simulation failed: ${method}` }));
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a new bookable service slot.
 *
 * @param {object} payload
 * @param {string} payload.id          - Unique slot ID (≤ 32 chars, no spaces).
 * @param {string} payload.provider    - Provider Stellar public key.
 * @param {string} payload.serviceName - Display name for the service.
 * @param {number} payload.date        - Unix timestamp (s) for the date.
 * @param {number} payload.startTime   - Unix timestamp (s) for slot start.
 * @param {number} payload.endTime     - Unix timestamp (s) for slot end.
 * @param {number} payload.price       - Price in stroops (≥ 0).
 */
export const createSlot = async (payload) => {
    if (!payload?.id)       throw new Error("Slot ID is required.");
    if (!payload?.provider) throw new Error("Provider address is required.");

    try {
        return await invokeWrite("create_slot", [
            toSymbol(payload.id),
            new Address(payload.provider).toScVal(),
            nativeToScVal(payload.serviceName || ""),
            toU64(payload.date),
            toU64(payload.startTime),
            toU64(payload.endTime),
            toI128(payload.price),
        ]);
    } catch (err) {
        throw new Error(parseError(err));
    }
};

/**
 * Book an available slot.
 *
 * @param {object} payload
 * @param {string} payload.id       - Symbol ID of the slot.
 * @param {string} payload.customer - Customer Stellar public key.
 */
export const bookSlot = async (payload) => {
    if (!payload?.id)       throw new Error("Slot ID is required.");
    if (!payload?.customer) throw new Error("Customer address is required.");

    try {
        return await invokeWrite("book_slot", [
            toSymbol(payload.id),
            new Address(payload.customer).toScVal(),
        ]);
    } catch (err) {
        throw new Error(parseError(err));
    }
};

/**
 * Cancel an existing booking. Caller must be provider or customer.
 *
 * @param {object} payload
 * @param {string} payload.id     - Symbol ID of the slot.
 * @param {string} payload.caller - Cancelling party's public key.
 */
export const cancelBooking = async (payload) => {
    if (!payload?.id)     throw new Error("Slot ID is required.");
    if (!payload?.caller) throw new Error("Caller address is required.");

    try {
        return await invokeWrite("cancel_booking", [
            toSymbol(payload.id),
            new Address(payload.caller).toScVal(),
        ]);
    } catch (err) {
        throw new Error(parseError(err));
    }
};

/**
 * Mark a booked slot as completed. Only the provider may do this.
 *
 * @param {object} payload
 * @param {string} payload.id       - Symbol ID of the slot.
 * @param {string} payload.provider - Provider's public key.
 */
export const completeBooking = async (payload) => {
    if (!payload?.id)       throw new Error("Slot ID is required.");
    if (!payload?.provider) throw new Error("Provider address is required.");

    try {
        return await invokeWrite("complete_booking", [
            toSymbol(payload.id),
            new Address(payload.provider).toScVal(),
        ]);
    } catch (err) {
        throw new Error(parseError(err));
    }
};

/**
 * Update the price of an unbooked slot. Only the provider may do this.
 *
 * @param {object} payload
 * @param {string} payload.id        - Symbol ID of the slot.
 * @param {string} payload.provider  - Provider's public key.
 * @param {number} payload.newPrice  - New price in stroops.
 */
export const updatePrice = async (payload) => {
    if (!payload?.id)                     throw new Error("Slot ID is required.");
    if (!payload?.provider)               throw new Error("Provider address is required.");
    if (payload?.newPrice === undefined)  throw new Error("New price is required.");

    try {
        return await invokeWrite("update_price", [
            toSymbol(payload.id),
            new Address(payload.provider).toScVal(),
            toI128(payload.newPrice),
        ]);
    } catch (err) {
        throw new Error(parseError(err));
    }
};

/**
 * Delete an unbooked slot. Only the provider may do this.
 *
 * @param {object} payload
 * @param {string} payload.id       - Symbol ID of the slot.
 * @param {string} payload.provider - Provider's public key.
 */
export const deleteSlot = async (payload) => {
    if (!payload?.id)       throw new Error("Slot ID is required.");
    if (!payload?.provider) throw new Error("Provider address is required.");

    try {
        return await invokeWrite("delete_slot", [
            toSymbol(payload.id),
            new Address(payload.provider).toScVal(),
        ]);
    } catch (err) {
        throw new Error(parseError(err));
    }
};

/**
 * Fetch a single slot by its Symbol ID.
 *
 * @param {string} id - Symbol ID of the slot.
 * @returns {object|null}
 */
export const getSlot = async (id) => {
    if (!id) throw new Error("Slot ID is required.");
    try {
        return await invokeRead("get_slot", [toSymbol(id)]);
    } catch (err) {
        throw new Error(parseError(err));
    }
};

/**
 * List all slot Symbol IDs.
 *
 * @returns {string[]}
 */
export const listSlots = async () => {
    try {
        return await invokeRead("list_slots", []);
    } catch (err) {
        throw new Error(parseError(err));
    }
};

/**
 * Get the total number of slots ever created.
 *
 * @returns {number}
 */
export const getSlotCount = async () => {
    try {
        return await invokeRead("get_slot_count", []);
    } catch (err) {
        throw new Error(parseError(err));
    }
};

// ── Date Helpers (exported for UI convenience) ────────────────────────────────

/**
 * Convert a local datetime-local input value to a Unix timestamp (seconds).
 * @param {string} datetimeLocalValue - e.g. "2025-06-15T09:00"
 * @returns {number}
 */
export const datetimeToTs = (datetimeLocalValue) => {
    if (!datetimeLocalValue) return Math.floor(Date.now() / 1000);
    return Math.floor(new Date(datetimeLocalValue).getTime() / 1000);
};

/**
 * Convert a Unix timestamp (seconds) to a locale-friendly string.
 * @param {number|bigint} ts
 * @returns {string}
 */
export const tsToDisplay = (ts) => {
    if (!ts && ts !== 0) return "—";
    const ms = typeof ts === "bigint" ? Number(ts) * 1000 : Number(ts) * 1000;
    return new Date(ms).toLocaleString();
};

/**
 * Format stroops as a human-readable XLM amount.
 * @param {number|bigint} stroops
 * @returns {string}
 */
export const stroopsToXlm = (stroops) => {
    if (stroops === undefined || stroops === null) return "—";
    const num = typeof stroops === "bigint" ? Number(stroops) : Number(stroops);
    return (num / 10_000_000).toFixed(7).replace(/\.?0+$/, "") + " XLM";
};
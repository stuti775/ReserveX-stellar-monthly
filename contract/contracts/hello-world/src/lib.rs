#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, Address, Env, String,
    Symbol, Vec, token,
};

// ── Storage TTL Constants ────────────────────────────────────────────────────
/// ~7 days at 5s per ledger
const LEDGER_BUMP_AMOUNT: u32 = 120_960;
/// ~1 day — minimum threshold before bumping
const LEDGER_THRESHOLD: u32 = 17_280;

// ── Data Types ───────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub struct Slot {
    /// The address that created and owns this slot.
    pub provider: Address,
    /// The address that booked this slot (same as provider when unbooked).
    pub customer: Address,
    /// Whether the slot has an active booking.
    pub is_booked: bool,
    /// Human-readable name for the service.
    pub service_name: String,
    /// Unix timestamp (seconds) representing the calendar date.
    pub date: u64,
    /// Unix timestamp (seconds) for when the slot starts.
    pub start_time: u64,
    /// Unix timestamp (seconds) for when the slot ends.
    pub end_time: u64,
    /// Price in stroops (1 XLM = 10,000,000 stroops).
    pub price: i128,
    /// Lifecycle status: "available" | "booked" | "cancelled" | "completed"
    pub status: Symbol,
}

#[contracttype]
#[derive(Clone)]
pub enum SlotDataKey {
    /// Ordered list of all slot IDs.
    IdList,
    /// Individual slot keyed by its Symbol ID.
    Slot(Symbol),
    /// Running count of total slots ever created.
    Count,
}

#[contracterror]
#[derive(Copy, Clone, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum SlotError {
    InvalidServiceName = 1,
    InvalidTimeRange   = 2,
    NotFound           = 3,
    AlreadyExists      = 4,
    AlreadyBooked      = 5,
    NotBooked          = 6,
    Unauthorized       = 7,
    InvalidStatus      = 8,
    InvalidPrice       = 9,
}

// ── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct BookingReservationContract;

#[contractimpl]
impl BookingReservationContract {
    // ── Internal Helpers ─────────────────────────────────────────────────────

    fn slot_key(id: &Symbol) -> SlotDataKey {
        SlotDataKey::Slot(id.clone())
    }

    fn load_ids(env: &Env) -> Vec<Symbol> {
        env.storage()
            .instance()
            .get(&SlotDataKey::IdList)
            .unwrap_or(Vec::new(env))
    }

    fn save_ids(env: &Env, ids: &Vec<Symbol>) {
        env.storage().instance().set(&SlotDataKey::IdList, ids);
    }

    /// Bump the instance TTL so the contract remains alive.
    fn bump_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(LEDGER_THRESHOLD, LEDGER_BUMP_AMOUNT);
    }

    // ── Write Methods ─────────────────────────────────────────────────────────

    pub fn create_slot(
        env: Env,
        id: Symbol,
        provider: Address,
        service_name: String,
        date: u64,
        start_time: u64,
        end_time: u64,
        price: i128,
    ) {
        provider.require_auth();

        if service_name.len() == 0 {
            panic_with_error!(&env, SlotError::InvalidServiceName);
        }
        if start_time >= end_time {
            panic_with_error!(&env, SlotError::InvalidTimeRange);
        }
        if price < 0 {
            panic_with_error!(&env, SlotError::InvalidPrice);
        }

        let key = Self::slot_key(&id);
        if env.storage().instance().has(&key) {
            panic_with_error!(&env, SlotError::AlreadyExists);
        }

        let slot = Slot {
            provider: provider.clone(),
            customer: provider,
            is_booked: false,
            service_name,
            date,
            start_time,
            end_time,
            price,
            status: Symbol::new(&env, "available"),
        };

        env.storage().instance().set(&key, &slot);

        let mut ids = Self::load_ids(&env);
        ids.push_back(id);
        Self::save_ids(&env, &ids);

        let count: u32 = env
            .storage()
            .instance()
            .get(&SlotDataKey::Count)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&SlotDataKey::Count, &(count + 1));

        Self::bump_instance(&env);
    }

    /// Book an available slot for a customer. Escrows the tokens into the contract.
    pub fn book_slot(env: Env, id: Symbol, customer: Address, token: Address) {
        customer.require_auth();

        let key = Self::slot_key(&id);
        let maybe: Option<Slot> = env.storage().instance().get(&key);

        match maybe {
            Some(mut slot) => {
                if slot.is_booked {
                    panic_with_error!(&env, SlotError::AlreadyBooked);
                }

                // Transfer payment to contract escrow
                if slot.price > 0 {
                    let client = token::Client::new(&env, &token);
                    client.transfer(&customer, &env.current_contract_address(), &slot.price);
                }

                slot.customer = customer;
                slot.is_booked = true;
                slot.status = Symbol::new(&env, "booked");

                env.storage().instance().set(&key, &slot);
                Self::bump_instance(&env);
            }
            None => panic_with_error!(&env, SlotError::NotFound),
        }
    }

    /// Cancel an active booking. Refunds the escrowed tokens to the customer.
    pub fn cancel_booking(env: Env, id: Symbol, caller: Address, token: Address) {
        caller.require_auth();

        let key = Self::slot_key(&id);
        let maybe: Option<Slot> = env.storage().instance().get(&key);

        match maybe {
            Some(mut slot) => {
                if !slot.is_booked {
                    panic_with_error!(&env, SlotError::NotBooked);
                }
                if slot.provider != caller && slot.customer != caller {
                    panic_with_error!(&env, SlotError::Unauthorized);
                }

                // Refund payment back to the customer
                if slot.price > 0 {
                    let client = token::Client::new(&env, &token);
                    client.transfer(&env.current_contract_address(), &slot.customer, &slot.price);
                }

                slot.is_booked = false;
                slot.status = Symbol::new(&env, "cancelled");

                env.storage().instance().set(&key, &slot);
                Self::bump_instance(&env);
            }
            None => panic_with_error!(&env, SlotError::NotFound),
        }
    }

    /// Mark a booked slot as completed. Releases the escrowed tokens to the provider.
    pub fn complete_booking(env: Env, id: Symbol, provider: Address, token: Address) {
        provider.require_auth();

        let key = Self::slot_key(&id);
        let maybe: Option<Slot> = env.storage().instance().get(&key);

        match maybe {
            Some(mut slot) => {
                if slot.provider != provider {
                    panic_with_error!(&env, SlotError::Unauthorized);
                }
                if !slot.is_booked {
                    panic_with_error!(&env, SlotError::NotBooked);
                }

                // Release payment to the provider
                if slot.price > 0 {
                    let client = token::Client::new(&env, &token);
                    client.transfer(&env.current_contract_address(), &slot.provider, &slot.price);
                }

                slot.status = Symbol::new(&env, "completed");

                env.storage().instance().set(&key, &slot);
                Self::bump_instance(&env);
            }
            None => panic_with_error!(&env, SlotError::NotFound),
        }
    }

    pub fn update_price(env: Env, id: Symbol, provider: Address, new_price: i128) {
        provider.require_auth();

        if new_price < 0 {
            panic_with_error!(&env, SlotError::InvalidPrice);
        }

        let key = Self::slot_key(&id);
        let maybe: Option<Slot> = env.storage().instance().get(&key);

        match maybe {
            Some(mut slot) => {
                if slot.provider != provider {
                    panic_with_error!(&env, SlotError::Unauthorized);
                }
                if slot.is_booked {
                    panic_with_error!(&env, SlotError::AlreadyBooked);
                }

                slot.price = new_price;
                env.storage().instance().set(&key, &slot);
                Self::bump_instance(&env);
            }
            None => panic_with_error!(&env, SlotError::NotFound),
        }
    }

    pub fn delete_slot(env: Env, id: Symbol, provider: Address) {
        provider.require_auth();

        let key = Self::slot_key(&id);
        let maybe: Option<Slot> = env.storage().instance().get(&key);

        match maybe {
            Some(slot) => {
                if slot.provider != provider {
                    panic_with_error!(&env, SlotError::Unauthorized);
                }
                if slot.is_booked {
                    panic_with_error!(&env, SlotError::AlreadyBooked);
                }

                env.storage().instance().remove(&key);

                let ids = Self::load_ids(&env);
                let mut new_ids: Vec<Symbol> = Vec::new(&env);
                for stored_id in ids.iter() {
                    if stored_id != id {
                        new_ids.push_back(stored_id);
                    }
                }
                Self::save_ids(&env, &new_ids);
                Self::bump_instance(&env);
            }
            None => panic_with_error!(&env, SlotError::NotFound),
        }
    }

    // ── Read Methods ──────────────────────────────────────────────────────────

    pub fn get_slot(env: Env, id: Symbol) -> Option<Slot> {
        Self::bump_instance(&env);
        env.storage().instance().get(&Self::slot_key(&id))
    }

    pub fn list_slots(env: Env) -> Vec<Symbol> {
        Self::bump_instance(&env);
        Self::load_ids(&env)
    }

    pub fn get_slot_count(env: Env) -> u32 {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&SlotDataKey::Count)
            .unwrap_or(0)
    }
}
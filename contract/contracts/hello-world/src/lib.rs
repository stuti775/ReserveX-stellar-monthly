#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, Address, Env, String,
    Symbol, Vec,
};

#[contracttype]
#[derive(Clone)]
pub struct Slot {
    pub provider: Address,
    pub customer: Address,
    pub is_booked: bool,
    pub service_name: String,
    pub date: u64,
    pub start_time: u64,
    pub end_time: u64,
    pub price: i128,
    pub status: Symbol,
}

#[contracttype]
#[derive(Clone)]
pub enum SlotDataKey {
    IdList,
    Slot(Symbol),
    Count,
}

#[contracterror]
#[derive(Copy, Clone, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum SlotError {
    InvalidServiceName = 1,
    InvalidTimeRange = 2,
    NotFound = 3,
    AlreadyExists = 4,
    AlreadyBooked = 5,
    NotBooked = 6,
    Unauthorized = 7,
    InvalidStatus = 8,
}

#[contract]
pub struct BookingReservationContract;

#[contractimpl]
impl BookingReservationContract {
    fn slot_key(id: &Symbol) -> SlotDataKey {
        SlotDataKey::Slot(id.clone())
    }

    fn load_ids(env: &Env) -> Vec<Symbol> {
        env.storage().instance().get(&SlotDataKey::IdList).unwrap_or(Vec::new(env))
    }

    fn save_ids(env: &Env, ids: &Vec<Symbol>) {
        env.storage().instance().set(&SlotDataKey::IdList, ids);
    }

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

        let key = Self::slot_key(&id);
        if env.storage().instance().has(&key) {
            panic_with_error!(&env, SlotError::AlreadyExists);
        }

        let available = Symbol::new(&env, "available");

        let slot = Slot {
            provider: provider.clone(),
            customer: provider,
            is_booked: false,
            service_name,
            date,
            start_time,
            end_time,
            price,
            status: available,
        };

        env.storage().instance().set(&key, &slot);

        let mut ids = Self::load_ids(&env);
        ids.push_back(id);
        Self::save_ids(&env, &ids);

        let count: u32 = env.storage().instance().get(&SlotDataKey::Count).unwrap_or(0);
        env.storage().instance().set(&SlotDataKey::Count, &(count + 1));
    }

    pub fn book_slot(env: Env, id: Symbol, customer: Address) {
        customer.require_auth();

        let key = Self::slot_key(&id);
        let maybe: Option<Slot> = env.storage().instance().get(&key);

        if let Some(mut slot) = maybe {
            if slot.is_booked {
                panic_with_error!(&env, SlotError::AlreadyBooked);
            }

            let booked = Symbol::new(&env, "booked");
            slot.customer = customer;
            slot.is_booked = true;
            slot.status = booked;

            env.storage().instance().set(&key, &slot);
        } else {
            panic_with_error!(&env, SlotError::NotFound);
        }
    }

    pub fn cancel_booking(env: Env, id: Symbol, caller: Address) {
        caller.require_auth();

        let key = Self::slot_key(&id);
        let maybe: Option<Slot> = env.storage().instance().get(&key);

        if let Some(mut slot) = maybe {
            if !slot.is_booked {
                panic_with_error!(&env, SlotError::NotBooked);
            }
            if slot.provider != caller && slot.customer != caller {
                panic_with_error!(&env, SlotError::Unauthorized);
            }

            let cancelled = Symbol::new(&env, "cancelled");
            slot.is_booked = false;
            slot.status = cancelled;

            env.storage().instance().set(&key, &slot);
        } else {
            panic_with_error!(&env, SlotError::NotFound);
        }
    }

    pub fn complete_booking(env: Env, id: Symbol, provider: Address) {
        provider.require_auth();

        let key = Self::slot_key(&id);
        let maybe: Option<Slot> = env.storage().instance().get(&key);

        if let Some(mut slot) = maybe {
            if slot.provider != provider {
                panic_with_error!(&env, SlotError::Unauthorized);
            }
            if !slot.is_booked {
                panic_with_error!(&env, SlotError::NotBooked);
            }

            let completed = Symbol::new(&env, "completed");
            slot.status = completed;

            env.storage().instance().set(&key, &slot);
        } else {
            panic_with_error!(&env, SlotError::NotFound);
        }
    }

    pub fn get_slot(env: Env, id: Symbol) -> Option<Slot> {
        env.storage().instance().get(&Self::slot_key(&id))
    }

    pub fn list_slots(env: Env) -> Vec<Symbol> {
        Self::load_ids(&env)
    }

    pub fn get_slot_count(env: Env) -> u32 {
        env.storage().instance().get(&SlotDataKey::Count).unwrap_or(0)
    }
}
// 5IVE bundled stdlib (v1, compiler-provided)
// Canonical explicit imports:
// use std::builtins;
// use std::interfaces::spl_token;
// use std::interfaces::system_program;
// Call interface methods via module aliases:
// spl_token::transfer(...);
// system_program::transfer(...);

// Basic 5ive DSL program (valid-first starter)

account Counter {
    value: u64;
    authority: pubkey;
}

pub init_counter(
    counter: Counter @mut,
    authority: account @signer
) {
    counter.value = 0;
    counter.authority = authority.ctx.key;
}

pub increment(
    counter: Counter @mut,
    authority: account @signer
) {
    require(counter.authority == authority.ctx.key);
    counter.value = counter.value + 1;
}

pub get_value(counter: Counter) -> u64 {
    return counter.value;
}

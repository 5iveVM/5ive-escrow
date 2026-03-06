interface SPLToken @program("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") {
    transfer @discriminator(3) (
        source: account,
        destination: account,
        authority: account @signer,
        amount: u64
    );
}

account EscrowState {
    seed: u64;
    maker: pubkey;
    taker: pubkey;
    maker_ata_b: pubkey;
    vault: pubkey;
    deposit_amount: u64;
    receive_amount: u64;
    status: u64;
}

pub make(
    maker: account @mut @signer,
    maker_ata_a: account @mut,
    maker_ata_b: account,
    vault: account @mut,
    escrow: EscrowState @mut,
    token_program: account,
    taker: pubkey,
    seed: u64,
    deposit_amount: u64,
    receive_amount: u64
) {
    require(deposit_amount > 0);
    require(receive_amount > 0);
    require(maker.ctx.key != taker);

    escrow.seed = seed;
    escrow.maker = maker.ctx.key;
    escrow.taker = taker;
    escrow.maker_ata_b = maker_ata_b.ctx.key;
    escrow.vault = vault.ctx.key;
    escrow.deposit_amount = deposit_amount;
    escrow.receive_amount = receive_amount;
    escrow.status = 0;

    SPLToken::transfer(maker_ata_a, vault, maker, deposit_amount);
}

pub take(
    taker: account @mut @signer,
    maker: account,
    taker_ata_a: account @mut,
    taker_ata_b: account @mut,
    maker_ata_b: account @mut,
    vault: account @mut,
    escrow: EscrowState @mut @signer,
    token_program: account
) {
    require(escrow.status == 0);
    require(maker.ctx.key == escrow.maker);
    require(taker.ctx.key == escrow.taker);
    require(maker_ata_b.ctx.key == escrow.maker_ata_b);
    require(vault.ctx.key == escrow.vault);

    SPLToken::transfer(taker_ata_b, maker_ata_b, taker, escrow.receive_amount);
    SPLToken::transfer(vault, taker_ata_a, escrow, escrow.deposit_amount);

    escrow.status = 1;
}

pub refund(
    maker: account @mut @signer,
    maker_ata_a: account @mut,
    vault: account @mut,
    escrow: EscrowState @mut @signer,
    token_program: account
) {
    require(escrow.status == 0);
    require(maker.ctx.key == escrow.maker);
    require(vault.ctx.key == escrow.vault);

    SPLToken::transfer(vault, maker_ata_a, escrow, escrow.deposit_amount);
    escrow.status = 2;
}

pub get_status(escrow: EscrowState) -> u64 {
    return escrow.status;
}

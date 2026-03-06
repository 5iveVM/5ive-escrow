import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { inspect } from 'util';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, } from '@solana/web3.js';
import { ACCOUNT_SIZE, TOKEN_PROGRAM_ID, createInitializeAccountInstruction, createMint, getAccount, getMinimumBalanceForRentExemptAccount, getOrCreateAssociatedTokenAccount, mintTo, } from '@solana/spl-token';
import { FiveProgram, FiveSDK } from '@5ive-tech/sdk';
const NETWORK = process.env.FIVE_NETWORK || 'localnet';
const RPC_URL = process.env.FIVE_RPC_URL ||
    (NETWORK === 'devnet' ? 'https://api.devnet.solana.com' : 'http://127.0.0.1:8899');
const FIVE_VM_PROGRAM_ID = process.env.FIVE_VM_PROGRAM_ID ||
    process.env.FIVE_PROGRAM_ID ||
    (NETWORK === 'devnet'
        ? '4Qxf3pbCse2veUgZVMiAm3nWqJrYo2pT4suxHKMJdK1d'
        : 'FmzLpEQryX1UDtNjDBPx9GDsXiThFtzjsZXtTLNLU7Vb');
const EXISTING_SCRIPT_ACCOUNT = process.env.FIVE_SCRIPT_ACCOUNT || '';
const CONFIRM = {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
    skipPreflight: true,
};
function parseConsumedUnits(logs) {
    if (!logs)
        return null;
    for (const line of logs) {
        const m = line.match(/consumed (\d+) of/);
        if (m)
            return Number(m[1]);
    }
    return null;
}
function printableError(err) {
    if (err instanceof Error) {
        if (err.message && err.message.length > 0)
            return err.message;
        return err.stack || `${err.name}: <empty message>`;
    }
    try {
        const json = JSON.stringify(err);
        if (json && json !== '{}')
            return json;
    }
    catch {
        // ignore
    }
    return inspect(err, { depth: 5, breakLength: 120 });
}
async function loadPayer() {
    const path = process.env.SOLANA_KEYPAIR_PATH || join(homedir(), '.config/solana/id.json');
    const secret = JSON.parse(await readFile(path, 'utf8'));
    return Keypair.fromSecretKey(new Uint8Array(secret));
}
async function sendIx(connection, payer, encoded, signers, name) {
    const tx = new Transaction().add(new TransactionInstruction({
        programId: new PublicKey(encoded.programId),
        keys: encoded.keys.map((k) => ({
            pubkey: new PublicKey(k.pubkey),
            isSigner: k.isSigner,
            isWritable: k.isWritable,
        })),
        data: Buffer.from(encoded.data, 'base64'),
    }));
    tx.feePayer = payer.publicKey;
    const allSignersMap = new Map();
    allSignersMap.set(payer.publicKey.toBase58(), payer);
    for (const signer of signers) {
        allSignersMap.set(signer.publicKey.toBase58(), signer);
    }
    const requiredSignerSet = new Set(encoded.keys.filter((k) => k.isSigner).map((k) => k.pubkey));
    const neededSigners = Array.from(allSignersMap.values()).filter((kp) => kp.publicKey.equals(payer.publicKey) || requiredSignerSet.has(kp.publicKey.toBase58()));
    try {
        const signature = await connection.sendTransaction(tx, neededSigners, CONFIRM);
        const latest = await connection.getLatestBlockhash('confirmed');
        await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
        const txMeta = await connection.getTransaction(signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
        });
        const metaErr = txMeta?.meta?.err ?? null;
        const cu = txMeta?.meta?.computeUnitsConsumed ?? parseConsumedUnits(txMeta?.meta?.logMessages);
        return {
            name,
            signature,
            computeUnits: cu,
            ok: metaErr == null,
            err: metaErr == null ? null : JSON.stringify(metaErr),
        };
    }
    catch (err) {
        return {
            name,
            signature: null,
            computeUnits: null,
            ok: false,
            err: printableError(err),
        };
    }
}
async function expectFailure(run) {
    const result = await run();
    if (result.ok)
        return { ...result, ok: false, err: 'unexpected success' };
    return { ...result, ok: true, err: 'expected failure' };
}
async function sendSystemTx(connection, payer, ix, signers, name) {
    try {
        const tx = new Transaction().add(ix);
        const signature = await connection.sendTransaction(tx, [payer, ...signers], CONFIRM);
        await connection.confirmTransaction(signature, 'confirmed');
        const meta = await connection.getTransaction(signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
        });
        return {
            name,
            signature,
            computeUnits: meta?.meta?.computeUnitsConsumed ?? parseConsumedUnits(meta?.meta?.logMessages),
            ok: meta?.meta?.err == null,
            err: meta?.meta?.err ? JSON.stringify(meta.meta.err) : null,
        };
    }
    catch (err) {
        return {
            name,
            signature: null,
            computeUnits: null,
            ok: false,
            err: printableError(err),
        };
    }
}
async function createOwnedAccount(connection, payer, account, owner, space) {
    const lamports = await connection.getMinimumBalanceForRentExemption(space);
    return sendSystemTx(connection, payer, SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: account.publicKey,
        lamports,
        space,
        programId: owner,
    }), [account], `setup:create_owned:${account.publicKey.toBase58()}`);
}
async function createTokenVault(connection, payer, mint, owner) {
    const vault = Keypair.generate();
    const lamports = await getMinimumBalanceForRentExemptAccount(connection);
    const tx = new Transaction().add(SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: vault.publicKey,
        space: ACCOUNT_SIZE,
        lamports,
        programId: TOKEN_PROGRAM_ID,
    }), createInitializeAccountInstruction(vault.publicKey, mint, owner, TOKEN_PROGRAM_ID));
    const signature = await connection.sendTransaction(tx, [payer, vault], CONFIRM);
    const latest = await connection.getLatestBlockhash('confirmed');
    await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
    return vault;
}
async function deployScript(connection, payer, loaded) {
    let result = await FiveSDK.deployToSolana(loaded.bytecode, connection, payer, {
        fiveVMProgramId: FIVE_VM_PROGRAM_ID,
    });
    if (!result.success && String(result.error || '').toLowerCase().includes('transaction too large')) {
        result = await FiveSDK.deployLargeProgramToSolana(loaded.bytecode, connection, payer, {
            fiveVMProgramId: FIVE_VM_PROGRAM_ID,
        });
    }
    const scriptAccount = result.scriptAccount || result.programId;
    if (!result.success || !scriptAccount) {
        throw new Error(`deploy failed: ${result.error || 'unknown error'}`);
    }
    return {
        scriptAccount,
        signature: result.transactionId || null,
        deploymentCost: result.deploymentCost || null,
    };
}
function pad(name) {
    return name.padEnd(36, ' ');
}
async function assertTokenDelta(connection, account, before, expectedDelta, name) {
    const after = (await getAccount(connection, account, 'confirmed', TOKEN_PROGRAM_ID)).amount;
    if (after - before !== expectedDelta) {
        throw new Error(`${name} token delta mismatch: expected ${expectedDelta}, got ${after - before}`);
    }
}
async function main() {
    const connection = new Connection(RPC_URL, 'confirmed');
    const payer = await loadPayer();
    const artifactCandidates = [
        join(process.cwd(), '..', 'build', 'main.five'),
        join(process.cwd(), '..', 'build', '5ive-escrow.five'),
    ];
    let artifactText = '';
    let artifactPath = '';
    for (const candidate of artifactCandidates) {
        try {
            artifactText = await readFile(candidate, 'utf8');
            artifactPath = candidate;
            break;
        }
        catch {
            continue;
        }
    }
    if (!artifactText) {
        throw new Error(`missing build artifact: ${artifactCandidates.join(', ')}`);
    }
    const loaded = await FiveSDK.loadFiveFile(artifactText);
    const deploy = EXISTING_SCRIPT_ACCOUNT
        ? { scriptAccount: EXISTING_SCRIPT_ACCOUNT, signature: null, deploymentCost: 0 }
        : await deployScript(connection, payer, loaded);
    const program = FiveProgram.fromABI(deploy.scriptAccount, loaded.abi, {
        fiveVMProgramId: FIVE_VM_PROGRAM_ID,
    });
    const setup = [];
    const report = [];
    const vmProgramPk = new PublicKey(FIVE_VM_PROGRAM_ID);
    const depositAmount = 1000000n;
    const receiveAmount = 1500000n;
    const seed = Math.floor(Date.now() / 1000);
    const decimals = 6;
    const maker = Keypair.generate();
    const taker = Keypair.generate();
    setup.push(await sendSystemTx(connection, payer, SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: maker.publicKey, lamports: 30_000_000 }), [], 'setup:fund_maker'));
    setup.push(await sendSystemTx(connection, payer, SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: taker.publicKey, lamports: 30_000_000 }), [], 'setup:fund_taker'));
    const mintA = await createMint(connection, payer, maker.publicKey, null, decimals);
    const mintB = await createMint(connection, payer, taker.publicKey, null, decimals);
    const makerAtaA = await getOrCreateAssociatedTokenAccount(connection, payer, mintA, maker.publicKey);
    const makerAtaB = await getOrCreateAssociatedTokenAccount(connection, payer, mintB, maker.publicKey);
    const takerAtaA = await getOrCreateAssociatedTokenAccount(connection, payer, mintA, taker.publicKey);
    const takerAtaB = await getOrCreateAssociatedTokenAccount(connection, payer, mintB, taker.publicKey);
    await mintTo(connection, payer, mintA, makerAtaA.address, maker, 10_000_000);
    await mintTo(connection, payer, mintB, takerAtaB.address, taker, 10_000_000);
    const escrow = Keypair.generate();
    setup.push(await createOwnedAccount(connection, payer, escrow, vmProgramPk, 256));
    const vault = await createTokenVault(connection, payer, mintA, escrow.publicKey);
    const makerAtaABefore = (await getAccount(connection, makerAtaA.address, 'confirmed', TOKEN_PROGRAM_ID)).amount;
    const vaultBefore = (await getAccount(connection, vault.publicKey, 'confirmed', TOKEN_PROGRAM_ID)).amount;
    const makeIx = await program
        .function('make')
        .payer(payer.publicKey.toBase58())
        .accounts({
        maker: maker.publicKey.toBase58(),
        maker_ata_a: makerAtaA.address.toBase58(),
        maker_ata_b: makerAtaB.address.toBase58(),
        vault: vault.publicKey.toBase58(),
        escrow: escrow.publicKey.toBase58(),
        token_program: TOKEN_PROGRAM_ID.toBase58(),
    })
        .args({ taker: taker.publicKey.toBase58(), seed, deposit_amount: Number(depositAmount), receive_amount: Number(receiveAmount) })
        .instruction();
    report.push(await sendIx(connection, payer, makeIx, [maker], 'make:happy'));
    if (report[report.length - 1].ok) {
        await assertTokenDelta(connection, makerAtaA.address, makerAtaABefore, -depositAmount, 'make:maker_ata_a');
        await assertTokenDelta(connection, vault.publicKey, vaultBefore, depositAmount, 'make:vault');
    }
    const takerAtaABefore = (await getAccount(connection, takerAtaA.address, 'confirmed', TOKEN_PROGRAM_ID)).amount;
    const takerAtaBBefore = (await getAccount(connection, takerAtaB.address, 'confirmed', TOKEN_PROGRAM_ID)).amount;
    const makerAtaBBefore = (await getAccount(connection, makerAtaB.address, 'confirmed', TOKEN_PROGRAM_ID)).amount;
    const takeIx = await program
        .function('take')
        .payer(payer.publicKey.toBase58())
        .accounts({
        taker: taker.publicKey.toBase58(),
        maker: maker.publicKey.toBase58(),
        taker_ata_a: takerAtaA.address.toBase58(),
        taker_ata_b: takerAtaB.address.toBase58(),
        maker_ata_b: makerAtaB.address.toBase58(),
        vault: vault.publicKey.toBase58(),
        escrow: escrow.publicKey.toBase58(),
        token_program: TOKEN_PROGRAM_ID.toBase58(),
    })
        .args({})
        .instruction();
    report.push(await sendIx(connection, payer, takeIx, [taker, escrow], 'take:happy'));
    if (report[report.length - 1].ok) {
        await assertTokenDelta(connection, takerAtaA.address, takerAtaABefore, depositAmount, 'take:taker_ata_a');
        await assertTokenDelta(connection, takerAtaB.address, takerAtaBBefore, -receiveAmount, 'take:taker_ata_b');
        await assertTokenDelta(connection, makerAtaB.address, makerAtaBBefore, receiveAmount, 'take:maker_ata_b');
    }
    report.push(await expectFailure(async () => sendIx(connection, payer, takeIx, [taker, escrow], 'take:double_settlement_fails')));
    const refundAfterTakeIx = await program
        .function('refund')
        .payer(payer.publicKey.toBase58())
        .accounts({
        maker: maker.publicKey.toBase58(),
        maker_ata_a: makerAtaA.address.toBase58(),
        vault: vault.publicKey.toBase58(),
        escrow: escrow.publicKey.toBase58(),
        token_program: TOKEN_PROGRAM_ID.toBase58(),
    })
        .args({})
        .instruction();
    report.push(await expectFailure(async () => sendIx(connection, payer, refundAfterTakeIx, [maker, escrow], 'refund:after_take_fails')));
    const maker2 = Keypair.generate();
    const taker2 = Keypair.generate();
    setup.push(await sendSystemTx(connection, payer, SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: maker2.publicKey, lamports: 30_000_000 }), [], 'setup:fund_maker_2'));
    setup.push(await sendSystemTx(connection, payer, SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: taker2.publicKey, lamports: 30_000_000 }), [], 'setup:fund_taker_2'));
    const maker2AtaA = await getOrCreateAssociatedTokenAccount(connection, payer, mintA, maker2.publicKey);
    const maker2AtaB = await getOrCreateAssociatedTokenAccount(connection, payer, mintB, maker2.publicKey);
    const taker2AtaA = await getOrCreateAssociatedTokenAccount(connection, payer, mintA, taker2.publicKey);
    const taker2AtaB = await getOrCreateAssociatedTokenAccount(connection, payer, mintB, taker2.publicKey);
    await mintTo(connection, payer, mintA, maker2AtaA.address, maker, 10_000_000);
    await mintTo(connection, payer, mintB, taker2AtaB.address, taker, 10_000_000);
    const escrow2 = Keypair.generate();
    setup.push(await createOwnedAccount(connection, payer, escrow2, vmProgramPk, 256));
    const vault2 = await createTokenVault(connection, payer, mintA, escrow2.publicKey);
    const make2Ix = await program
        .function('make')
        .payer(payer.publicKey.toBase58())
        .accounts({
        maker: maker2.publicKey.toBase58(),
        maker_ata_a: maker2AtaA.address.toBase58(),
        maker_ata_b: maker2AtaB.address.toBase58(),
        vault: vault2.publicKey.toBase58(),
        escrow: escrow2.publicKey.toBase58(),
        token_program: TOKEN_PROGRAM_ID.toBase58(),
    })
        .args({ taker: taker2.publicKey.toBase58(), seed: seed + 1, deposit_amount: Number(depositAmount), receive_amount: Number(receiveAmount) })
        .instruction();
    report.push(await sendIx(connection, payer, make2Ix, [maker2], 'make:refund_flow'));
    const badRefundIx = await program
        .function('refund')
        .payer(payer.publicKey.toBase58())
        .accounts({
        maker: taker2.publicKey.toBase58(),
        maker_ata_a: taker2AtaA.address.toBase58(),
        vault: vault2.publicKey.toBase58(),
        escrow: escrow2.publicKey.toBase58(),
        token_program: TOKEN_PROGRAM_ID.toBase58(),
    })
        .args({})
        .instruction();
    report.push(await expectFailure(async () => sendIx(connection, payer, badRefundIx, [taker2, escrow2], 'refund:wrong_signer_fails')));
    const wrongVault = await createTokenVault(connection, payer, mintA, escrow2.publicKey);
    const badTakeIx = await program
        .function('take')
        .payer(payer.publicKey.toBase58())
        .accounts({
        taker: taker2.publicKey.toBase58(),
        maker: maker2.publicKey.toBase58(),
        taker_ata_a: taker2AtaA.address.toBase58(),
        taker_ata_b: taker2AtaB.address.toBase58(),
        maker_ata_b: maker2AtaB.address.toBase58(),
        vault: wrongVault.publicKey.toBase58(),
        escrow: escrow2.publicKey.toBase58(),
        token_program: TOKEN_PROGRAM_ID.toBase58(),
    })
        .args({})
        .instruction();
    report.push(await expectFailure(async () => sendIx(connection, payer, badTakeIx, [taker2, escrow2], 'take:wrong_vault_fails')));
    const maker2AtaABefore = (await getAccount(connection, maker2AtaA.address, 'confirmed', TOKEN_PROGRAM_ID)).amount;
    const refundIx = await program
        .function('refund')
        .payer(payer.publicKey.toBase58())
        .accounts({
        maker: maker2.publicKey.toBase58(),
        maker_ata_a: maker2AtaA.address.toBase58(),
        vault: vault2.publicKey.toBase58(),
        escrow: escrow2.publicKey.toBase58(),
        token_program: TOKEN_PROGRAM_ID.toBase58(),
    })
        .args({})
        .instruction();
    report.push(await sendIx(connection, payer, refundIx, [maker2, escrow2], 'refund:happy'));
    if (report[report.length - 1].ok) {
        await assertTokenDelta(connection, maker2AtaA.address, maker2AtaABefore, depositAmount, 'refund:maker_ata_a');
    }
    report.push(await expectFailure(async () => sendIx(connection, payer, refundIx, [maker2, escrow2], 'refund:double_settlement_fails')));
    console.log(`--- 5ive-escrow ${NETWORK} report ---`);
    console.log('artifact:', artifactPath);
    console.log('network:', NETWORK);
    console.log('rpc:', RPC_URL);
    console.log('five_vm_program_id:', FIVE_VM_PROGRAM_ID);
    console.log('script_account:', deploy.scriptAccount);
    console.log('deploy_signature:', deploy.signature);
    console.log('deployment_cost_lamports:', deploy.deploymentCost);
    for (const item of report) {
        console.log(`${pad(item.name)} | ok=${item.ok} | sig=${item.signature ?? 'n/a'} | cu=${item.computeUnits ?? 'n/a'} | err=${item.err ?? 'none'}`);
    }
    const failedSetup = setup.filter((r) => !r.ok);
    const failed = report.filter((r) => !r.ok);
    if (failedSetup.length > 0 || failed.length > 0)
        process.exitCode = 1;
}
main().catch((err) => {
    console.error('run failed:', printableError(err));
    process.exit(1);
});

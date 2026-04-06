import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { inspect } from 'util';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type ConfirmOptions,
} from '@solana/web3.js';
import {
  ACCOUNT_SIZE,
  TOKEN_PROGRAM_ID,
  createInitializeAccountInstruction,
  createMint,
  getAccount,
  getMinimumBalanceForRentExemptAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from '@solana/spl-token';
import { FiveProgram, FiveSDK } from '@5ive-tech/sdk';

type StepResult = {
  name: string;
  signature: string | null;
  computeUnits: number | null;
  ok: boolean;
  err: string | null;
};

const NETWORK = process.env.FIVE_NETWORK || 'localnet';
const NORMALIZED_NETWORK = NETWORK === 'local' ? 'localnet' : NETWORK;
const RPC_BY_NETWORK: Record<string, string> = {
  localnet: 'http://127.0.0.1:8899',
  devnet: 'https://api.devnet.solana.com',
  mainnet: 'https://api.mainnet-beta.solana.com',
};
const PROGRAM_BY_NETWORK: Record<string, string> = {
  localnet: '55555SyrYLzydvDMBhAL8uo6h4WETHTm81z8btf6nAVJ',
  devnet: '55555SyrYLzydvDMBhAL8uo6h4WETHTm81z8btf6nAVJ',
  mainnet: '55555SyrYLzydvDMBhAL8uo6h4WETHTm81z8btf6nAVJ',
};
const EXISTING_SCRIPT_ACCOUNT = process.env.FIVE_SCRIPT_ACCOUNT || '';
const CONFIRM: ConfirmOptions = {
  commitment: 'confirmed',
  preflightCommitment: 'confirmed',
  skipPreflight: false,
};

function parseConsumedUnits(logs: string[] | null | undefined): number | null {
  if (!logs) return null;
  for (const line of logs) {
    const m = line.match(/consumed (\d+) of/);
    if (m) return Number(m[1]);
  }
  return null;
}

function printableError(err: unknown): string {
  if (err instanceof Error) {
    if (err.message && err.message.length > 0) return err.message;
    return err.stack || `${err.name}: <empty message>`;
  }
  try {
    const json = JSON.stringify(err);
    if (json && json !== '{}') return json;
  } catch {
    // ignore
  }
  return inspect(err, { depth: 5, breakLength: 120 });
}

async function loadDeploymentConfig(network: string): Promise<{ rpcUrl?: string; fiveProgramId?: string }> {
  const path = join(process.cwd(), '..', `deployment-config.${network}.json`);
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as { rpcUrl?: string; fiveProgramId?: string };
    return parsed;
  } catch {
    return {};
  }
}

async function loadPayer(): Promise<Keypair> {
  const path = process.env.SOLANA_KEYPAIR_PATH || join(homedir(), '.config/solana/id.json');
  const secret = JSON.parse(await readFile(path, 'utf8')) as number[];
  return Keypair.fromSecretKey(new Uint8Array(secret));
}

async function sendIx(
  connection: Connection,
  payer: Keypair,
  encoded: any,
  signers: Keypair[],
  name: string
): Promise<StepResult> {
  const tx = new Transaction().add(
    new TransactionInstruction({
      programId: new PublicKey(encoded.programId),
      keys: encoded.keys.map((k: any) => ({
        pubkey: new PublicKey(k.pubkey),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      })),
      data: Buffer.from(encoded.data, 'base64'),
    })
  );
  tx.feePayer = payer.publicKey;

  const allSignersMap = new Map<string, Keypair>();
  allSignersMap.set(payer.publicKey.toBase58(), payer);
  for (const signer of signers) {
    allSignersMap.set(signer.publicKey.toBase58(), signer);
  }

  const requiredSignerSet = new Set(
    encoded.keys.filter((k: any) => k.isSigner).map((k: any) => k.pubkey)
  );
  const neededSigners = Array.from(allSignersMap.values()).filter(
    (kp) => kp.publicKey.equals(payer.publicKey) || requiredSignerSet.has(kp.publicKey.toBase58())
  );

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
  } catch (err) {
    return {
      name,
      signature: null,
      computeUnits: null,
      ok: false,
      err: printableError(err),
    };
  }
}

async function expectFailure(run: () => Promise<StepResult>): Promise<StepResult> {
  const result = await run();
  if (result.ok) return { ...result, ok: false, err: 'unexpected success' };
  return { ...result, ok: true, err: 'expected failure' };
}

async function sendSystemTx(
  connection: Connection,
  payer: Keypair,
  ix: TransactionInstruction,
  signers: Keypair[],
  name: string
): Promise<StepResult> {
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
  } catch (err) {
    return {
      name,
      signature: null,
      computeUnits: null,
      ok: false,
      err: printableError(err),
    };
  }
}

async function createOwnedAccount(
  connection: Connection,
  payer: Keypair,
  account: Keypair,
  owner: PublicKey,
  space: number
): Promise<StepResult> {
  const lamports = await connection.getMinimumBalanceForRentExemption(space);
  return sendSystemTx(
    connection,
    payer,
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: account.publicKey,
      lamports,
      space,
      programId: owner,
    }),
    [account],
    `setup:create_owned:${account.publicKey.toBase58()}`
  );
}

async function createTokenVault(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey
): Promise<Keypair> {
  const vault = Keypair.generate();
  const lamports = await getMinimumBalanceForRentExemptAccount(connection);
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: vault.publicKey,
      space: ACCOUNT_SIZE,
      lamports,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeAccountInstruction(vault.publicKey, mint, owner, TOKEN_PROGRAM_ID)
  );
  const signature = await connection.sendTransaction(tx, [payer, vault], CONFIRM);
  const latest = await connection.getLatestBlockhash('confirmed');
  await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
  return vault;
}

async function deployScript(connection: Connection, payer: Keypair, loaded: any, fiveVmProgramId: string) {
  let result: any = await FiveSDK.deployToSolana(loaded.bytecode, connection, payer, {
    fiveVMProgramId: fiveVmProgramId,
  });

  if (!result.success && String(result.error || '').toLowerCase().includes('transaction too large')) {
    result = await FiveSDK.deployLargeProgramToSolana(loaded.bytecode, connection, payer, {
      fiveVMProgramId: fiveVmProgramId,
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

function pad(name: string): string {
  return name.padEnd(36, ' ');
}

async function assertTokenDelta(
  connection: Connection,
  account: PublicKey,
  before: bigint,
  expectedDelta: bigint,
  name: string
) {
  const after = (await getAccount(connection, account, 'confirmed', TOKEN_PROGRAM_ID)).amount;
  if (after - before !== expectedDelta) {
    throw new Error(`${name} token delta mismatch: expected ${expectedDelta}, got ${after - before}`);
  }
}

async function main() {
  const deploymentConfig = await loadDeploymentConfig(NORMALIZED_NETWORK);
  const rpcUrl =
    process.env.FIVE_RPC_URL ||
    deploymentConfig.rpcUrl ||
    (RPC_BY_NETWORK[NORMALIZED_NETWORK] || RPC_BY_NETWORK.localnet);
  const fiveVmProgramId =
    process.env.FIVE_VM_PROGRAM_ID ||
    process.env.FIVE_PROGRAM_ID ||
    deploymentConfig.fiveProgramId ||
    (PROGRAM_BY_NETWORK[NORMALIZED_NETWORK] || PROGRAM_BY_NETWORK.localnet);

  const connection = new Connection(rpcUrl, 'confirmed');
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
    } catch {
      continue;
    }
  }
  if (!artifactText) {
    throw new Error(`missing build artifact: ${artifactCandidates.join(', ')}`);
  }

  const loaded = await FiveSDK.loadFiveFile(artifactText);
  const deploy = EXISTING_SCRIPT_ACCOUNT
    ? { scriptAccount: EXISTING_SCRIPT_ACCOUNT, signature: null, deploymentCost: 0 }
    : await deployScript(connection, payer, loaded, fiveVmProgramId);
  const program = FiveProgram.fromABI(deploy.scriptAccount, loaded.abi, {
    fiveVMProgramId: fiveVmProgramId,
  });

  const setup: StepResult[] = [];
  const report: StepResult[] = [];
  const vmProgramPk = new PublicKey(fiveVmProgramId);

  const depositAmount = 1_000_000n;
  const receiveAmount = 1_500_000n;
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

  console.log(`--- 5ive-escrow ${NORMALIZED_NETWORK} report ---`);
  console.log('artifact:', artifactPath);
  console.log('network:', NORMALIZED_NETWORK);
  console.log('rpc:', rpcUrl);
  console.log('five_vm_program_id:', fiveVmProgramId);
  console.log('script_account:', deploy.scriptAccount);
  console.log('deploy_signature:', deploy.signature);
  console.log('deployment_cost_lamports:', deploy.deploymentCost);

  for (const item of report) {
    console.log(
      `${pad(item.name)} | ok=${item.ok} | sig=${item.signature ?? 'n/a'} | cu=${item.computeUnits ?? 'n/a'} | err=${item.err ?? 'none'}`
    );
  }

  const failedSetup = setup.filter((r) => !r.ok);
  const failed = report.filter((r) => !r.ok);
  if (failedSetup.length > 0 || failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('run failed:', printableError(err));
  process.exit(1);
});

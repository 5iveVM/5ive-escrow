# Scenarios

## Golden Path (Local)

```bash
npm run smoke
```

## On-Chain Path (Local Validator)

Prereqs:
- local validator running
- Five VM program deployed

```bash
npm run smoke:onchain:local
npm run client:run:local
```

## Optional Devnet Path

```bash
npm run test:onchain:devnet
npm run client:run:devnet
```

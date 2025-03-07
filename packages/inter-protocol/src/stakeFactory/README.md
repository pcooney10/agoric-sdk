# stakeFactory design notes

The stakeFactory contract provides loans on the basis of
staked assets that earn rewards.

The following sequence diagram shows an interaction between stakeFactory and:
  - dapp: with rich interaction but low privilege
  - walletBridge: with high privilege and constrained interaction
  - attestation: a service within the stakeFactory contract
  - Cosmos_SDK: the Cosmos SDK layer, including the `x/lien` module

Before this interaction, an `ag123` account has been provisioned,
which provides an `AttestationMaker` for that account to the wallet.

Note that the account already has 4000 BLD liened before this interaction.

```mermaid
sequenceDiagram
    actor dapp
    participant walletBridge
    participant attestation
    participant stakeFactory
    participant Cosmos_SDK

    note right of dapp: How dapp finds the current state

    note right of walletBridge: walletBridge is provided to dapps and controlled by Wallet UI
    dapp ->>+ walletBridge: getPurseBalance("BLD")
    dapp -->> walletBridge: 5000

    note right of attestation: ag123 is a cosmos address
    dapp ->> attestation: getMax(ag123)
    attestation ->> Cosmos_SDK: getAccountState(ag123)
    note right of Cosmos_SDK: Cosmos supports lien
    Cosmos_SDK -->> attestation: account status in which 4000 BLD liened
    attestation  -->> dapp: account status in which 4000 BLD liened
    note right of dapp: Treasury now knows

    note right of dapp: Want to get 450 IST by liening 500 BLD
    dapp ->> walletBridge: getReturnableAttestation(want: 450 IST, give: 500 BLD-Att)
    note right of walletBridge: Blocks on user approval in wallet
    walletBridge ->> attestation: makeAttestation(500 BLD)
    attestation ->> Cosmos_SDK: increaseLiened(+500 BLD)
    Cosmos_SDK -->> attestation: new lien balance or throws

    attestation -->> walletBridge: Payment of 500 BLD-Att liened on ag123

    walletBridge ->> stakeFactory: offer w/payment for {give: 500 BLD-Att, want: 450 IST} 

    stakeFactory --> walletBridge: Payment for 450 IST and offerResult
    walletBridge --> dapp: notifiers from offerResult
```

## Components

In addition to the `stakeFactory.js` module with the contract `start` function:

 - `params.js`: utilities for governance parameters
 - `stakeFactoryKit.js`: `makeStakeFactoryKit` is called once per loan
 - `stakeFactoryManager.js`: handles interest etc. for all loans
 - `attestation.js`: minting tokens that attest to liens,
      and wrapping them in per-user attestation maker authorities.

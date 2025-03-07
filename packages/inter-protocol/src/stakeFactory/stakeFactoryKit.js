// @jessie-check
import { AmountMath, AssetKind } from '@agoric/ertp';
import { bindAllMethods, makeTracer } from '@agoric/internal';
import { makePublishKit } from '@agoric/notifier';
import { M, matches } from '@agoric/store';
import { defineKindMulti } from '@agoric/vat-data';
import { assertProposalShape } from '@agoric/zoe/src/contractSupport/index.js';
import { ceilMultiplyBy } from '@agoric/zoe/src/contractSupport/ratio.js';
import { addSubtract, assertOnlyKeys } from '../contractSupport.js';
import { calculateCurrentDebt, reverseInterest } from '../interest-math.js';
import { ManagerKW as KW } from './constants.js';

const { Fail, quote: q } = assert;

const trace = makeTracer('R1');

/**
 * Calculate the fee, the amount to mint and the resulting debt.
 *
 * @param {Ratio} feeCoeff fee coefficient
 * @param {Amount<'nat'>} currentDebt
 * @param {Amount<'nat'>} giveAmount
 * @param {Amount<'nat'>} wantAmount
 */
const calculateFee = (feeCoeff, currentDebt, giveAmount, wantAmount) => {
  const fee = ceilMultiplyBy(wantAmount, feeCoeff);
  const toMint = AmountMath.add(wantAmount, fee);
  const newDebt = addSubtract(currentDebt, toMint, giveAmount);
  return { newDebt, toMint, fee };
};

/**
 * @typedef {Readonly<{
 *   collateralBrand: Brand,
 *   debtBrand: Brand<'nat'>,
 *   manager: import('./stakeFactoryManager.js').StakeFactoryManager,
 *   subscriber: Subscriber<unknown>
 *   vaultSeat: ZCFSeat,
 *   zcf: ZCF,
 * }>} ImmutableState
 * @typedef {{
 *   open: boolean,
 *   debtSnapshot: Amount<'nat'>,
 *   interestSnapshot: Ratio,
 *   publisher: Publisher<unknown> | null,
 * }} MutableState
 * @typedef {MutableState & ImmutableState} State
 * @typedef {{
 *   state: State,
 *   facets: {
 *     helper: import('@agoric/vat-data/src/types').KindFacet<typeof helperBehavior>,
 *     pot: import('@agoric/vat-data/src/types').KindFacet<typeof potBehavior>,
 *   },
 * }} MethodContext
 */

/**
 * Make stakeFactory kit state
 *
 * @param {ZCF} zcf
 * @param {ZCFSeat} startSeat
 * @param {import('./stakeFactoryManager.js').StakeFactoryManager} manager
 * @returns {State}
 */
const initState = (zcf, startSeat, manager) => {
  const collateralBrand = manager.getCollateralBrand();
  const debtBrand = manager.getDebtBrand();

  const { zcfSeat: vaultSeat } = zcf.makeEmptySeatKit();

  const emptyDebt = AmountMath.makeEmpty(debtBrand);

  const initialDebt = (() => {
    assertProposalShape(startSeat, {
      give: { [KW.Attestation]: null },
      want: { [KW.Debt]: null },
    });
    const {
      give: { [KW.Attestation]: attestationGiven },
      want: { [KW.Debt]: runWanted },
    } = startSeat.getProposal();

    const { maxDebt } = manager.maxDebtForLien(attestationGiven);
    AmountMath.isGTE(maxDebt, runWanted) ||
      Fail`wanted ${runWanted}, more than max debt (${maxDebt}) for ${attestationGiven}`;

    const { newDebt, fee, toMint } = calculateFee(
      manager.getLoanFee(),
      emptyDebt,
      emptyDebt,
      runWanted,
    );
    !AmountMath.isEmpty(fee) ||
      Fail`loan requested (${runWanted}) is too small; cannot accrue interest`;
    AmountMath.isEqual(newDebt, toMint) || Fail`loan fee mismatch`;
    trace('init', { runWanted, fee, attestationGiven });

    manager.mintAndReallocate(
      startSeat,
      toMint,
      fee,
      harden([[startSeat, vaultSeat, { [KW.Attestation]: attestationGiven }]]),
    );

    startSeat.exit();
    return newDebt;
  })();
  manager.applyDebtDelta(emptyDebt, initialDebt);

  const { publisher, subscriber } = makePublishKit();

  /** @type {ImmutableState} */
  const immutable = {
    collateralBrand,
    debtBrand,
    manager,
    subscriber,
    vaultSeat,
    zcf,
  };
  return {
    ...immutable,
    open: true,
    // Two values from the same moment
    interestSnapshot: manager.getCompoundedInterest(),
    debtSnapshot: initialDebt,
    publisher,
  };
};
const helperBehavior = {
  /**
   * @param {MethodContext} context
   * @param {ZCFSeat} seat
   */
  getCollateralAllocated: ({ state }, seat) =>
    seat.getAmountAllocated(KW.Attestation, state.collateralBrand),
  /**
   * @param {MethodContext} context
   * @param {ZCFSeat} seat
   */
  getMintedAllocated: ({ state }, seat) =>
    seat.getAmountAllocated(KW.Debt, state.debtBrand),
  /**
   * @param {MethodContext} context
   */
  getCollateralAmount: ({ state, facets }) => {
    const { collateralBrand, vaultSeat } = state;
    const { helper } = facets;
    const emptyCollateral = AmountMath.makeEmpty(
      collateralBrand,
      AssetKind.COPY_BAG,
    );
    // getCollateralAllocated would return final allocations
    return vaultSeat.hasExited()
      ? emptyCollateral
      : helper.getCollateralAllocated(vaultSeat);
  },

  /**
   * @param {MethodContext} context
   *  @param {boolean} newActive */
  snapshotState: ({ state, facets }, newActive) => {
    const { debtSnapshot: debt, interestSnapshot: interest } = state;
    const { helper } = facets;
    /** @type {VaultNotification} */
    const result = harden({
      debtSnapshot: { debt, interest },
      locked: helper.getCollateralAmount(),
      // newPhase param is so that makeTransferInvitation can finish without setting the vault's phase
      // TODO refactor https://github.com/Agoric/agoric-sdk/issues/4415
      vaultState: newActive ? 'active' : 'closed',
    });
    return result;
  },

  /**
   * call this whenever anything changes!
   *
   * @param {MethodContext} context
   */
  updateUiState: async ({ state, facets }) => {
    const { open: active, publisher } = state;
    if (!publisher) {
      console.warn('updateUiState called after ui.publisher removed');
      return;
    }
    const uiState = facets.helper.snapshotState(active);
    trace('updateUiState', uiState);

    if (active) {
      publisher.publish(uiState);
    } else {
      publisher.finish(uiState);
      state.publisher = null;
    }
  },

  /**
   * Called whenever the debt is paid or created through a transaction,
   * but not for interest accrual.
   *
   * @param {MethodContext} context
   * @param {Amount<'nat'>} newDebt - principal and all accrued interest
   */
  updateDebtSnapshot: ({ state }, newDebt) => {
    const { manager } = state;
    // update local state
    state.debtSnapshot = newDebt;
    state.interestSnapshot = manager.getCompoundedInterest();
  },

  /**
   * Update the debt balance and propagate upwards to
   * maintain aggregate debt and liquidation order.
   *
   * @param {MethodContext} context
   * @param {Amount<'nat'>} oldDebt - prior principal and all accrued interest
   * @param {Amount<'nat'>} newDebt - actual principal and all accrued interest
   */
  updateDebtAccounting: ({ state, facets }, oldDebt, newDebt) => {
    const { manager } = state;
    const { helper } = facets;
    helper.updateDebtSnapshot(newDebt);
    // update vault manager which tracks total debt
    manager.applyDebtDelta(oldDebt, newDebt);
  },

  /**
   * @param {MethodContext} context
   */
  assertVaultHoldsNoMinted: ({ state, facets }) => {
    const { vaultSeat } = state;
    const { helper } = facets;
    AmountMath.isEmpty(helper.getMintedAllocated(vaultSeat)) ||
      Fail`Vault should be empty of debt`;
  },

  /**
   * Adjust principal and collateral (atomically for offer safety)
   *
   * @param {MethodContext} context
   * @param {ZCFSeat} clientSeat
   */
  adjustBalancesHook: ({ state, facets }, clientSeat) => {
    const { collateralBrand, debtBrand, manager, vaultSeat } = state;
    const { helper, pot } = facets;
    assert(state.open);

    const proposal = clientSeat.getProposal();
    assertOnlyKeys(proposal, [KW.Attestation, KW.Debt]);

    const debt = pot.getCurrentDebt();
    const collateral = helper.getCollateralAllocated(vaultSeat);

    const emptyCollateral = AmountMath.makeEmpty(
      collateralBrand,
      AssetKind.COPY_BAG,
    );
    const giveColl = proposal.give.Attestation || emptyCollateral;
    const wantColl = proposal.want.Attestation || emptyCollateral;

    // new = after the transaction gets applied
    const newCollateral = addSubtract(collateral, giveColl, wantColl);
    // max debt supported by current Collateral as modified by proposal
    const { amountLiened, maxDebt: newMaxDebt } =
      manager.maxDebtForLien(newCollateral);

    const emptyDebt = AmountMath.makeEmpty(debtBrand);
    const give = AmountMath.min(proposal.give.Debt || emptyDebt, debt);
    const want = proposal.want.Debt || emptyDebt;
    const giveDebtOnly = matches(
      proposal,
      harden({ give: { [KW.Debt]: M.record() }, want: {}, exit: M.any() }),
    );

    // Calculate the fee, the amount to mint and the resulting debt. We'll
    // verify that the target debt doesn't violate the collateralization ratio,
    // then mint, reallocate, and burn.
    const { newDebt, fee, toMint } = calculateFee(
      manager.getLoanFee(),
      debt,
      give,
      want,
    );
    assert(
      giveDebtOnly || AmountMath.isGTE(newMaxDebt, newDebt),
      `cannot borrow ${q(newDebt)} against ${q(amountLiened)}; max is ${q(
        newMaxDebt,
      )}`,
    );

    trace('adjustBalancesHook', {
      targetCollateralAmount: newCollateral,
      vaultCollateral: newCollateral,
      fee,
      toMint,
      newDebt,
    });

    manager.mintAndReallocate(
      clientSeat,
      toMint,
      fee,
      harden([
        [clientSeat, vaultSeat, { [KW.Attestation]: giveColl }],
        [vaultSeat, clientSeat, { [KW.Attestation]: wantColl }],
        [clientSeat, vaultSeat, { [KW.Debt]: give }],
        // Minted into vaultSeat requires minting and so is done by mintAndTransfer
      ]),
    );

    // parent needs to know about the change in debt
    helper.updateDebtAccounting(debt, newDebt);

    manager.burnDebt(give, vaultSeat);

    helper.assertVaultHoldsNoMinted();

    void helper.updateUiState();
    clientSeat.exit();

    return 'We have adjusted your balances; thank you for your business.';
  },

  /**
   * Given sufficient Minted payoff, refund the attestation.
   *
   * @type {import('@agoric/vat-data/src/types').PlusContext<MethodContext, OfferHandler>}
   */
  closeHook: ({ state, facets }, seat) => {
    const { debtBrand, manager, vaultSeat, zcf } = state;
    const { helper, pot } = facets;
    assert(state.open);
    assertProposalShape(seat, {
      give: { [KW.Debt]: null },
      want: { [KW.Attestation]: null },
    });

    const currentDebt = pot.getCurrentDebt();
    const {
      give: { [KW.Debt]: runOffered },
    } = seat.getProposal();
    AmountMath.isGTE(runOffered, currentDebt) ||
      Fail`Offer ${runOffered} is not sufficient to pay off debt ${currentDebt}`;
    vaultSeat.incrementBy(seat.decrementBy(harden({ [KW.Debt]: currentDebt })));
    seat.incrementBy(
      vaultSeat.decrementBy(
        harden({ Attestation: vaultSeat.getAmountAllocated('Attestation') }),
      ),
    );

    zcf.reallocate(seat, vaultSeat);

    manager.burnDebt(currentDebt, vaultSeat);
    state.open = false;
    helper.updateDebtSnapshot(AmountMath.makeEmpty(debtBrand));
    void helper.updateUiState();
    helper.assertVaultHoldsNoMinted();
    seat.exit();

    return 'Your stakeFactory is closed; thank you for your business.';
  },
};

const potBehavior = {
  /** @param {MethodContext} context */
  getSubscriber: ({ state }) => state.subscriber,
  /** @param {MethodContext} context */
  makeAdjustBalancesInvitation: ({ state, facets }) => {
    const { zcf } = state;
    const { helper } = facets;
    assert(state.open);
    return zcf.makeInvitation(
      seat => helper.adjustBalancesHook(seat),
      'AdjustBalances',
    );
  },
  /** @param {MethodContext} context */
  makeCloseInvitation: ({ state, facets }) => {
    const { zcf } = state;
    const { helper } = facets;
    assert(state.open);
    return zcf.makeInvitation(seat => helper.closeHook(seat), 'CloseVault');
  },
  /**
   * The actual current debt, including accrued interest.
   *
   * This looks like a simple getter but it does a lot of the heavy lifting for
   * interest accrual. Rather than updating all records when interest accrues,
   * the vault manager updates just its rolling compounded interest. Here we
   * calculate what the current debt is given what's recorded in this vault and
   * what interest has compounded since this vault record was written.
   *
   * @see getNormalizedDebt
   * @param {MethodContext} context
   * @returns {Amount<'nat'>}
   */
  getCurrentDebt: ({ state }) => {
    return calculateCurrentDebt(
      state.debtSnapshot,
      state.interestSnapshot,
      state.manager.getCompoundedInterest(),
    );
  },
  /** @param {MethodContext} context */
  getNormalizedDebt: ({ state }) =>
    reverseInterest(state.debtSnapshot, state.interestSnapshot),
};

const behavior = {
  helper: helperBehavior,
  pot: potBehavior,
};

/**
 * @param {MethodContext} context
 */
const finish = ({ facets }) => {
  const { helper } = facets;
  void helper.updateUiState();
};

/**
 * Make stakeFactory kit, subject to stakeFactory terms.
 *
 * @param {ZCF} zcf
 * @param {ZCFSeat} startSeat
 * @param {import('./stakeFactoryManager.js').StakeFactoryManager} manager
 * @throws {Error} if startSeat proposal is not consistent with governance parameters in manager
 */
const makeStakeFactoryKitInternal = defineKindMulti(
  'stakeFactoryKit',
  initState,
  behavior,
  { finish },
);

/**
 * Make stakeFactory kit, subject to stakeFactory terms.
 *
 * TODO refactor to remove this wrapper around the kind and to stop using
 * `bindAllMethods`.
 *
 * @param {ZCF} zcf
 * @param {ZCFSeat} startSeat
 * @param {import('./stakeFactoryManager.js').StakeFactoryManager} manager
 * @throws {Error} if startSeat proposal is not consistent with governance parameters in manager
 */
export const makeStakeFactoryKit = (zcf, startSeat, manager) => {
  const { helper, pot } = makeStakeFactoryKitInternal(zcf, startSeat, manager);
  return harden({
    // XXX work- around for change from auto - binding
    helper: bindAllMethods(helper),
    pot,
  });
};

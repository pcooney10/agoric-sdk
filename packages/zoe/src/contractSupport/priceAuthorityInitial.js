// @ts-check
import { E } from '@endo/far';
import { Far } from '@endo/marshal';

import { makeNotifier } from '@agoric/notifier';
import { AmountMath } from '@agoric/ertp';

import { multiplyBy } from './ratio.js';
import { mintQuote } from './priceAuthorityTransform.js';

/** @template T @typedef {import('@endo/eventual-send').EOnly<T>} EOnly */

/**
 * Override `makeQuoteNotifier`, `quoteGiven` to provide an initial price
 * in case one is not yet available from the source.
 *
 * Mainly for testing vaults without waiting for oracle operators to PushPrice.
 *
 * @param {Ratio} priceOutPerIn
 * @param {PriceAuthority} priceAuthority
 * @param {ERef<Mint<'set'>>} quoteMint
 * @param {Brand<'nat'>} brandIn
 * @param {Brand<'nat'>} brandOut
 * @returns {PriceAuthority}
 */
export const makeInitialTransform = (
  priceOutPerIn,
  priceAuthority,
  quoteMint,
  brandIn,
  brandOut,
) => {
  assert.equal(priceOutPerIn.numerator.brand, brandOut);
  assert.equal(priceOutPerIn.denominator.brand, brandIn);
  let initialMode = true;

  const quoteBrandP = E(E(quoteMint).getIssuer()).getBrand();
  const timerP = E(priceAuthority).getTimerService(brandIn, brandOut);

  /**
   * @param {Amount<'nat'>} amountIn
   * @param {Amount<'nat'>} amountOut
   * @returns {Promise<PriceQuote>}
   */
  const mintCurrentQuote = async (amountIn, amountOut) => {
    const [quoteBrand, timer, timestamp] = await Promise.all([
      quoteBrandP,
      timerP,
      E(timerP).getCurrentTimestamp(),
    ]);

    return mintQuote(
      quoteBrand,
      amountIn,
      amountOut,
      timer,
      timestamp,
      quoteMint,
    );
  };

  /** @type {PriceAuthority['makeQuoteNotifier']} */
  const makeQuoteNotifier = (amountIn, bOut) => {
    AmountMath.coerce(brandIn, amountIn);
    assert.equal(bOut, brandOut);

    const notifier = E(priceAuthority).makeQuoteNotifier(amountIn, brandOut);

    const initialUpdateP = mintCurrentQuote(
      priceOutPerIn.denominator,
      priceOutPerIn.numerator,
    ).then(value => harden({ value, updateCount: 0n }));

    // Wrap our underlying notifier.
    const prefixedNotifier = harden({
      async getUpdateSince(updateCount = -1n) {
        if (initialMode && updateCount === -1n) {
          return initialUpdateP;
        }

        initialMode = false;
        return E(notifier).getUpdateSince(updateCount);
      },
    });

    /** @type {Notifier<PriceQuote>} */
    const farNotifier = Far('QuoteNotifier', {
      ...makeNotifier(prefixedNotifier),
      // TODO stop exposing baseNotifier methods directly.
      ...prefixedNotifier,
    });
    return farNotifier;
  };

  /** @type {PriceAuthority['quoteGiven']} */
  const quoteGiven = async (amountIn, bOut) => {
    AmountMath.coerce(brandIn, amountIn);
    assert.equal(bOut, brandOut);

    const quoteP = E(priceAuthority).quoteGiven(amountIn, brandOut);
    quoteP.then(() => (initialMode = false));
    return initialMode
      ? mintCurrentQuote(amountIn, multiplyBy(amountIn, priceOutPerIn))
      : quoteP;
  };

  return Far('PriceAuthority', {
    ...priceAuthority,
    makeQuoteNotifier,
    quoteGiven,
  });
};

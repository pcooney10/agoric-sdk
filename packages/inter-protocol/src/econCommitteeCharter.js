import '@agoric/governance/exported.js';
import { makeScalarMapStore, M, makeExo, mustMatch } from '@agoric/store';
import '@agoric/zoe/exported.js';
import '@agoric/zoe/src/contracts/exported.js';
import { InstanceHandleShape } from '@agoric/zoe/src/typeGuards.js';
import { TimestampShape } from '@agoric/time';
import { E } from '@endo/far';

/**
 * @file
 *
 * This contract makes it possible for those who govern contracts to call for
 * votes on changes. A more complete implementation would validate parameters,
 * constrain deadlines and possibly split the ability to call for votes into
 * separate capabilities for finer grain encapsulation.
 */

export const INVITATION_MAKERS_DESC = 'charter member invitation';

/**
 * @typedef {object} ParamChangesOfferArgs
 * @property {bigint} deadline
 * @property {Instance} instance
 * @property {Record<string, unknown>} params
 * @property {{paramPath: { key: string }}} [path]
 */
const ParamChangesOfferArgsShape = M.splitRecord(
  {
    deadline: TimestampShape,
    instance: InstanceHandleShape,
    params: M.recordOf(M.string(), M.any()),
  },
  {
    path: { paramPath: { key: M.any() } },
  },
);

/**
 * @param {ZCF<{binaryVoteCounterInstallation:Installation}>} zcf
 */
export const start = async zcf => {
  const { binaryVoteCounterInstallation: counter } = zcf.getTerms();
  /** @type {MapStore<Instance,GovernedContractFacetAccess<{},{}>>} */
  const instanceToGovernor = makeScalarMapStore();

  const makeParamInvitation = () => {
    /**
     * @param {ZCFSeat} seat
     * @param {ParamChangesOfferArgs} args
     */
    const voteOnParamChanges = (seat, args) => {
      mustMatch(args, ParamChangesOfferArgsShape);
      seat.exit();

      const {
        params,
        instance,
        deadline,
        path = { paramPath: { key: 'governedApi' } },
      } = args;
      const governor = instanceToGovernor.get(instance);
      return E(governor).voteOnParamChanges(counter, deadline, {
        ...path,
        changes: params,
      });
    };

    return zcf.makeInvitation(voteOnParamChanges, 'vote on param changes');
  };

  const makeOfferFilterInvitation = (instance, strings, deadline) => {
    const voteOnOfferFilterHandler = seat => {
      seat.exit();

      const governor = instanceToGovernor.get(instance);
      return E(governor).voteOnOfferFilter(counter, deadline, strings);
    };

    return zcf.makeInvitation(voteOnOfferFilterHandler, 'vote on offer filter');
  };

  /**
   * @param {Instance} instance
   * @param {string} methodName
   * @param {string[]} methodArgs
   * @param {import('@agoric/time').TimestampValue} deadline
   */
  const makeApiInvocationInvitation = (
    instance,
    methodName,
    methodArgs,
    deadline,
  ) => {
    const handler = seat => {
      seat.exit();

      const governor = instanceToGovernor.get(instance);
      return E(governor).voteOnApiInvocation(
        methodName,
        methodArgs,
        counter,
        deadline,
      );
    };
    return zcf.makeInvitation(handler, 'vote on API invocation');
  };

  const MakerI = M.interface('Charter InvitationMakers', {
    VoteOnParamChange: M.call().returns(M.promise()),
    VoteOnPauseOffers: M.call(
      InstanceHandleShape,
      M.arrayOf(M.string()),
      TimestampShape,
    ).returns(M.promise()),
    VoteOnApiCall: M.call(
      InstanceHandleShape,
      M.string(),
      M.arrayOf(M.any()),
      TimestampShape,
    ).returns(M.promise()),
  });
  const invitationMakers = makeExo('Charter Invitation Makers', MakerI, {
    VoteOnParamChange: makeParamInvitation,
    VoteOnPauseOffers: makeOfferFilterInvitation,
    VoteOnApiCall: makeApiInvocationInvitation,
  });

  const charterMemberHandler = seat => {
    seat.exit();
    return harden({ invitationMakers });
  };

  const charterCreatorI = M.interface('Charter creatorFacet', {
    addInstance: M.call(InstanceHandleShape, M.any())
      .optional(M.string())
      .returns(),
    makeCharterMemberInvitation: M.call().returns(M.promise()),
  });

  const creatorFacet = makeExo('Charter creatorFacet', charterCreatorI, {
    /**
     * @param {Instance} governedInstance
     * @param {GovernedContractFacetAccess<{},{}>} governorFacet
     * @param {string} [label] for diagnostic use only
     */
    addInstance: (governedInstance, governorFacet, label) => {
      console.log('charter: adding instance', label);
      instanceToGovernor.init(governedInstance, governorFacet);
    },
    makeCharterMemberInvitation: () =>
      zcf.makeInvitation(charterMemberHandler, INVITATION_MAKERS_DESC),
  });

  return harden({ creatorFacet });
};

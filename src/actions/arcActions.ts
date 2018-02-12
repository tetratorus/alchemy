import axios from 'axios';
import * as Arc from '@daostack/arc.js';
import promisify = require('es6-promisify');
import { normalize } from 'normalizr';
import * as Redux from 'redux';
import { push } from 'react-router-redux'
import { ThunkAction } from 'redux-thunk';
import * as Web3 from 'web3';

import * as web3Actions from 'actions/web3Actions';
import * as web3Constants from 'constants/web3Constants';
import * as arcConstants from 'constants/arcConstants';
import { IRootState } from 'reducers';
import * as schemas from '../schemas';

import { IDaoState, ICollaboratorState, IProposalState, ProposalStates } from 'reducers/arcReducer';

export function connectToArc() {
  return (dispatch : any) => {
    dispatch(web3Actions.initializeWeb3());
  }
}

export function getDAOs() {
  return async (dispatch: Redux.Dispatch<any>, getState: Function) => {
    dispatch({ type: arcConstants.ARC_GET_DAOS_PENDING, payload: null });

    const web3 = Arc.Utils.getWeb3();
    const daoCreator = await Arc.DaoCreator.deployed();

    // Get the list of daos we populated on the blockchain during genesis by looking for NewOrg events
    const newOrgEvents = daoCreator.contract.NewOrg({}, { fromBlock: 0 })
    newOrgEvents.get(async (err : Error, eventsArray : any[]) => {
      if (err) {
        dispatch({ type: arcConstants.ARC_GET_DAOS_REJECTED, payload: "Error getting new daos from genesis contract: " + err.message });
      }

      let daos = <{ [key : string] : IDaoState }>{};

      for (let index = 0; index < eventsArray.length; index++) {
        const event = eventsArray[index];
        daos[event.args._avatar] = await getDAOData(event.args._avatar, web3);
      }

      dispatch({ type: arcConstants.ARC_GET_DAOS_FULFILLED, payload: normalize(daos, schemas.daoList) });
    });
  };
}

export function getDAO(avatarAddress : string) {
  return async (dispatch: any, getState: any) => {
    dispatch({ type: arcConstants.ARC_GET_DAO_PENDING, payload: null });

    const web3 = Arc.Utils.getWeb3();
    const daoData = await getDAOData(avatarAddress, web3, true);
    dispatch({ type: arcConstants.ARC_GET_DAO_FULFILLED, payload: normalize(daoData, schemas.daoSchema) });
  }
}

export async function getDAOData(avatarAddress : string, web3 : any, detailed = false) {
  const dao = await Arc.DAO.at(avatarAddress);

  let daoData : IDaoState = {
    avatarAddress: avatarAddress,
    controllerAddress: "",
    name: await dao.getName(),
    members: [],
    rank: 1, // TODO
    promotedAmount: 0,
    proposals: [],
    reputationAddress: await dao.reputation.address,
    reputationCount: Number(web3.fromWei(await dao.reputation.totalSupply(), "ether")),
    tokenAddress: await dao.token.address,
    tokenCount: Number(web3.fromWei(await dao.token.totalSupply(), "ether")),
    tokenName: await dao.getTokenName(),
    tokenSymbol: await dao.getTokenSymbol(),
  };

  if (detailed) {
    // Get all collaborators
    const mintTokenEvents = dao.token.Mint({}, { fromBlock: 0 })
    const transferTokenEvents = dao.token.Transfer({}, { fromBlock: 0 });
    const mintReputationEvents = dao.reputation.Mint({}, { fromBlock: 0 });
    let collaboratorAddresses : string[] = [];

    const getMintTokenEvents = promisify(mintTokenEvents.get.bind(mintTokenEvents));
    let eventsArray = await getMintTokenEvents();
    for (let cnt = 0; cnt < eventsArray.length; cnt++) {
      collaboratorAddresses.push(eventsArray[cnt].args.to);
    }

    const getTransferTokenEvents = promisify(transferTokenEvents.get.bind(transferTokenEvents));
    eventsArray = await getTransferTokenEvents();
    for (let cnt = 0; cnt < eventsArray.length; cnt++) {
      collaboratorAddresses.push(eventsArray[cnt].args.to);
    }

    const getMintReputationEvents = promisify(mintReputationEvents.get.bind(mintReputationEvents));
    eventsArray = await getMintReputationEvents();
    for (let cnt = 0; cnt < eventsArray.length; cnt++) {
      collaboratorAddresses.push(eventsArray[cnt].args.to);
    }

    collaboratorAddresses = [...new Set(collaboratorAddresses)]; // Dedupe

    let collaborators : ICollaboratorState[] = [];
    for (let cnt = 0; cnt < collaboratorAddresses.length; cnt++) {
      const address = collaboratorAddresses[cnt];
      let collaborator = { address: address, tokens: 0, reputation: 0 };
      const tokens = await dao.token.balanceOf.call(address)
      collaborator.tokens = Number(web3.fromWei(tokens, "ether"));
      const reputation = await dao.reputation.reputationOf.call(address);
      collaborator.reputation = Number(web3.fromWei(reputation, "ether"));
      collaborators.push(collaborator);
    }
    daoData.members = collaborators;

    // Get proposals
    const contributionRewardInstance = await Arc.ContributionReward.deployed();
    const newProposalEvents = contributionRewardInstance.NewContributionProposal({}, { fromBlock: 0 });
    const getNewProposalEvents = promisify(newProposalEvents.get.bind(newProposalEvents));
    const allProposals = await getNewProposalEvents();

    const executedProposalEvents = contributionRewardInstance.ProposalExecuted({}, { fromBlock: 0 })
    const getExecutedProposalEvents = promisify(executedProposalEvents.get.bind(executedProposalEvents));
    const executedProposals = await getExecutedProposalEvents();
    const executedProposalIds = executedProposals.map((proposal : any) => proposal.args._proposalId);

    const failedProposalEvents = contributionRewardInstance.ProposalDeleted({}, { fromBlock: 0 });
    const getFailedProposalEvents = promisify(failedProposalEvents.get.bind(failedProposalEvents));
    const failedProposals = await getFailedProposalEvents();
    const failedProposalIds = failedProposals.map((proposal : any) => proposal.args._proposalId);

    let proposalArgs : any;
    for (let cnt = 0; cnt < allProposals.length; cnt++) {
      proposalArgs = allProposals[cnt].args;
      if (proposalArgs._avatar == dao.avatar.address) {
        // Default to showing the description hash if we don't have better description on the server
        let description = proposalArgs._contributionDescription;

        // Get description from the server
        // TODO: pull all the proposals for this DAO in one request
        try {
          const response = await axios.get(arcConstants.API_URL + '/api/proposals?filter={"where":{"arcId":"'+proposalArgs._proposalId+'"}}');
          if (response.data.length > 0) {
            description = response.data[0].description;
          }
        } catch (e) {
          console.log(e);
        }

        let proposal = <IProposalState>{
          beneficiary: proposalArgs._beneficiary,
          boostedAt: 0, // TODO
          description: description, // TODO
          daoAvatarAddress: dao.avatar.address,
          state: "NotBoosted", // TODO: Closed, Executed, NotBoosted, Boosted
          predictionsFail: 0, // TODO
          predictionsPass: 0, // TODO
          proposalId: proposalArgs._proposalId,
          rewardEth: 0, // TODO
          rewardReputation: Number(web3.fromWei(proposalArgs._rewards[1], "ether")),
          rewardToken: Number(web3.fromWei(proposalArgs._rewards[0], "ether")),
          submittedAt: 0, // TODO
          votesYes: 0,
          votesNo: 0,
          winningVote: 0
        };

        if (executedProposalIds.includes(proposalArgs._proposalId)) {
          proposal.state = ProposalStates.Executed;
          proposal.winningVote = 1;
        } else if (failedProposalIds.includes(proposalArgs._proposalId)) {
          proposal.state = ProposalStates.Executed;
          proposal.winningVote = 2;
        } else {
          // TODO: update as Arc.js supports better stuff
          const schemeParamsHash = await dao.controller.getSchemeParameters(contributionRewardInstance.contract.address, dao.avatar.address);
          const schemeParams = await contributionRewardInstance.contract.parameters(schemeParamsHash);
          const votingMachineAddress = schemeParams[2];
          const votingMachineInstance = await Arc.Utils.requireContract("AbsoluteVote").at(votingMachineAddress);

          const votesStatus = await votingMachineInstance.votesStatus(proposalArgs._proposalId);
          proposal.votesYes = Number(web3.fromWei(votesStatus[1], "ether"));
          proposal.votesNo = Number(web3.fromWei(votesStatus[2], "ether"));
        };
        daoData.proposals.push(proposal);
      }
    }
  }

  return daoData;
}

export function createDAO(daoName : string, tokenName: string, tokenSymbol: string, collaborators: any) : ThunkAction<any, IRootState, null> {
  return async (dispatch: Redux.Dispatch<any>, getState: () => IRootState) => {
    dispatch({ type: arcConstants.ARC_CREATE_DAO_PENDING, payload: null });
    try {
      const web3 : Web3 = Arc.Utils.getWeb3();

      let founders : Arc.FounderConfig[] = [], collaborator;
      collaborators.sort((a : any, b : any) => {
        b.reputation - a.reputation;
      });
      for (let i = 0; i < collaborators.length; i++) {
        collaborator = collaborators[i];
        founders[i] = {
          address : collaborator.address,
          tokens : web3.toWei(collaborator.tokens, "ether"),
          reputation: web3.toWei(collaborator.reputation, "ether")
        }
      }

      let schemes = [{
        name: "ContributionReward"
      }];

      let dao = await Arc.DAO.new({
        name: daoName,
        tokenName: tokenName,
        tokenSymbol: tokenSymbol,
        founders: founders,
        schemes: schemes
      });

      let daoData : IDaoState = {
        avatarAddress: dao.avatar.address,
        controllerAddress: dao.controller.address,
        name: daoName,
        members: [],
        rank: 1, // TODO
        promotedAmount: 0,
        proposals: [],
        reputationAddress: dao.reputation.address,
        reputationCount: 0,
        tokenAddress: dao.token.address,
        tokenCount: 0,
        tokenName: tokenName,
        tokenSymbol: tokenSymbol
      };

      dispatch({ type: arcConstants.ARC_CREATE_DAO_FULFILLED, payload: normalize(daoData, schemas.daoSchema) });
      dispatch(push('/dao/' + dao.avatar.address));
    } catch (err) {
      dispatch({ type: arcConstants.ARC_CREATE_DAO_REJECTED, payload: err.message });
    }
  } /* EO createDAO */
}

export function createProposal(daoAvatarAddress : string, description : string, nativeTokenReward: number, reputationReward: number, beneficiary: string) : ThunkAction<any, IRootState, null> {
  return async (dispatch: Redux.Dispatch<any>, getState: () => IRootState) => {
    dispatch({ type: arcConstants.ARC_CREATE_PROPOSAL_PENDING, payload: null });
    try {
      const web3 : Web3 = Arc.Utils.getWeb3();
      const ethAccountAddress : string = getState().web3.ethAccountAddress;

      const contributionRewardInstance = await Arc.ContributionReward.deployed();

      const submitProposalTransaction = await contributionRewardInstance.proposeContributionReward({
        avatar: daoAvatarAddress,
        description: description,
        nativeTokenReward : web3.toWei(nativeTokenReward, "ether"),
        reputationReward : web3.toWei(reputationReward, "ether"),
        beneficiary : beneficiary,
      });

      // TODO: error checking
      const proposalId = submitProposalTransaction.proposalId;
      const descriptionHash = submitProposalTransaction.getValueFromTx("_contributionDescription");

      try {
        const response = await axios.post(arcConstants.API_URL + '/api/proposals', {
          arcId: proposalId,
          daoAvatarAddress: daoAvatarAddress,
          descriptionHash: descriptionHash,
          description: description,
          title: "title"
        });
      } catch (e) {
        console.log(e);
      }

      const proposal = <IProposalState>{
        beneficiary: beneficiary,
        boostedAt: 0, // TODO
        description: description, // TODO
        daoAvatarAddress: daoAvatarAddress,
        state: "NotBoosted", // TODO, string // Closed, Executed, NotBoosted, Boosted
        predictionsFail: 0, // TODO
        predictionsPass: 0, // TODO
        proposalId: proposalId,
        rewardEth: 0, // TODO
        rewardReputation: reputationReward,
        rewardToken: nativeTokenReward,
        submittedAt: 0, // TODO
        votesYes: 0,
        votesNo: 0,
        winningVote: 0
      };

      let payload = normalize(proposal, schemas.proposalSchema);
      (payload as any).daoAvatarAddress = daoAvatarAddress;

      dispatch({ type: arcConstants.ARC_CREATE_PROPOSAL_FULFILLED, payload: payload });
      dispatch(push('/dao/' + daoAvatarAddress));
    } catch (err) {
      dispatch({ type: arcConstants.ARC_CREATE_PROPOSAL_REJECTED, payload: err.message });
    }
  }
}

export function voteOnProposal(daoAvatarAddress: string, proposalId: string|number, voterAddress: string, vote: number) {
  return async (dispatch: Redux.Dispatch<any>, getState: () => IRootState) => {
    dispatch({ type: arcConstants.ARC_VOTE_PENDING, payload: null });
    try {
      const web3 : Web3 = Arc.Utils.getWeb3();
      const ethAccountAddress : string = getState().web3.ethAccountAddress;

      const daoInstance = await Arc.DAO.at(daoAvatarAddress);
      const contributionRewardInstance = await Arc.ContributionReward.deployed();

      // TODO: clean this up once Arc.js makes it easier to get the votingMachine instance for a scheme/controller combo
      const schemeParamsHash = await daoInstance.controller.getSchemeParameters(contributionRewardInstance.contract.address, daoInstance.avatar.address);
      const schemeParams = await contributionRewardInstance.contract.parameters(schemeParamsHash);
      const votingMachineAddress = schemeParams[2]; // 2 is the index of the votingMachine address for the ContributionReward scheme
      const votingMachineInstance = await Arc.Utils.requireContract("AbsoluteVote").at(votingMachineAddress);

      const voteTransaction = await votingMachineInstance.vote(proposalId, vote, { from: ethAccountAddress, gas: 4000000 });
      const votesStatus = await votingMachineInstance.votesStatus(proposalId);

      let payload = {
        votesNo: Number(web3.fromWei(votesStatus[2], "ether")),
        daoAvatarAddress: daoAvatarAddress,
        proposalId: proposalId,
        state: "NotBoosted",
        votesYes: Number(web3.fromWei(votesStatus[1], "ether")),
        winningVote: 0
      }

      // See if the proposal was executed, either passing or failing
      const executed = voteTransaction.logs.find((log : any) => log.event == "LogExecuteProposal");
      if (executed) {
        const decision = executed.args._decision.toNumber();
        payload.state = "Executed";
        if (decision == 1) {
          payload.winningVote = 1;
        } else if (decision == 2) {
          payload.winningVote = 2;
        } else {
          dispatch({ type: arcConstants.ARC_VOTE_REJECTED, payload: "Unknown proposal decision ", decision });
          return
        }
      }

      dispatch({ type: arcConstants.ARC_VOTE_FULFILLED, payload: payload });
    } catch (err) {
      dispatch({ type: arcConstants.ARC_VOTE_REJECTED, payload: err.message });
    }
  }
}
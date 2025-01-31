import {
  TokenId,
  ChainName,
  ChainId,
} from '@wormhole-foundation/wormhole-connect-sdk';
import { BigNumber, utils } from 'ethers';

import { CHAINS, ROUTES, TOKENS, sdkConfig } from 'config';
import { TokenConfig, Route } from 'config/types';
import {
  MAX_DECIMALS,
  fromNormalizedDecimals,
  getTokenDecimals,
  getWrappedTokenId,
  toNormalizedDecimals,
  getDisplayName,
} from 'utils';
import {
  ParsedMessage,
  wh,
  isAcceptedToken,
  ParsedRelayerMessage,
  toChainId,
  calculateNativeTokenAmt,
  calculateMaxSwapAmount,
  PayloadType,
} from 'utils/sdk';
import { NO_INPUT } from 'utils/style';
import { TransferWallet, signAndSendTransaction } from 'utils/wallet';
import { BridgeRoute } from './bridge';
import { toDecimals, toFixedDecimals } from '../balance';
import {
  RelayTransferMessage,
  SignedRelayTransferMessage,
  TransferDisplayData,
} from './types';
import { adaptParsedMessage } from './common';
import { fetchSwapEvent } from '../events';
import {
  UnsignedMessage,
  SignedMessage,
  TransferInfoBaseParams,
} from './types';
import { fetchVaa } from '../vaa';

export type RelayOptions = {
  relayerFee?: number;
  toNativeToken?: number;
  receiveNativeAmt: number;
};

interface TransferDestInfoParams {
  txData: ParsedMessage | ParsedRelayerMessage;
  receiveTx?: string;
  transferComplete?: boolean;
}

export class RelayRoute extends BridgeRoute {
  readonly NATIVE_GAS_DROPOFF_SUPPORTED = true;
  readonly AUTOMATIC_DEPOSIT = true;

  isSupportedChain(chain: ChainName): boolean {
    return !!sdkConfig.chains[chain]?.contracts.relayer;
  }

  async isRouteAvailable(
    sourceToken: string,
    destToken: string,
    amount: string,
    sourceChain: ChainName | ChainId,
    destChain: ChainName | ChainId,
  ): Promise<boolean> {
    if (!ROUTES.includes(Route.Relay)) {
      return false;
    }

    const isBridgeRouteAvailable = await super.isRouteAvailable(
      sourceToken,
      destToken,
      amount,
      sourceChain,
      destChain,
    );
    if (!isBridgeRouteAvailable) return false;
    const sourceContracts = wh.mustGetContracts(sourceChain);
    const destContracts = wh.mustGetContracts(destChain);
    if (!sourceContracts.relayer || !destContracts.relayer) {
      return false;
    }
    const tokenConfig = TOKENS[sourceToken]!;
    const tokenId = getWrappedTokenId(tokenConfig);
    const accepted = await isAcceptedToken(tokenId);

    if (!accepted) return false;

    let relayerFee;
    try {
      relayerFee = await this.getRelayerFee(
        sourceChain,
        destChain,
        sourceToken,
      );
    } catch {}
    const decimals = getTokenDecimals(wh.toChainId(sourceChain), tokenId);
    return !(
      relayerFee === undefined ||
      parseFloat(amount) <
        this.getMinSendAmount({
          relayerFee: toDecimals(relayerFee, decimals),
          toNativeToken: 0,
        })
    );
  }

  async isSupportedSourceToken(
    token: TokenConfig | undefined,
    destToken: TokenConfig | undefined,
    sourceChain?: ChainName | ChainId,
  ): Promise<boolean> {
    if (!token) return false;
    const isSupportedBridgeToken = await super.isSupportedSourceToken(
      token,
      destToken,
      sourceChain,
    );
    if (!isSupportedBridgeToken) return false;
    const tokenId = getWrappedTokenId(token);
    return await isAcceptedToken(tokenId);
  }

  async isSupportedDestToken(
    token: TokenConfig | undefined,
    sourceToken: TokenConfig | undefined,
  ): Promise<boolean> {
    if (!token) return false;
    const isSupportedBridgeToken = await super.isSupportedDestToken(
      token,
      sourceToken,
    );
    if (!isSupportedBridgeToken) return false;
    const tokenId = getWrappedTokenId(token);
    return await isAcceptedToken(tokenId);
  }

  async supportedSourceTokens(
    tokens: TokenConfig[],
    destToken?: TokenConfig,
    sourceChain?: ChainName | ChainId,
  ): Promise<TokenConfig[]> {
    const shouldAdd = await Promise.allSettled(
      tokens.map((token) =>
        this.isSupportedSourceToken(token, destToken, sourceChain),
      ),
    );
    return tokens.filter((_token, i) => {
      const res = shouldAdd[i];
      return res.status === 'fulfilled' && res.value;
    });
  }

  async supportedDestTokens(
    tokens: TokenConfig[],
    sourceToken?: TokenConfig,
  ): Promise<TokenConfig[]> {
    const shouldAdd = await Promise.allSettled(
      tokens.map((token) => this.isSupportedDestToken(token, sourceToken)),
    );
    return tokens.filter((_token, i) => {
      const res = shouldAdd[i];
      return res.status === 'fulfilled' && res.value;
    });
  }

  async computeReceiveAmount(
    sendAmount: number | undefined,
    routeOptions: RelayOptions,
  ): Promise<number> {
    if (!sendAmount) return 0;
    return (
      sendAmount -
      (routeOptions?.toNativeToken || 0) -
      (routeOptions?.relayerFee || 0)
    );
  }
  async computeSendAmount(
    receiveAmount: number | undefined,
    routeOptions: RelayOptions,
  ): Promise<number> {
    if (!receiveAmount) return 0;
    return receiveAmount + (routeOptions?.toNativeToken || 0);
  }

  async nativeTokenAmount(
    destChain: ChainName | ChainId,
    token: TokenId,
    amount: BigNumber,
    walletAddress: string,
  ): Promise<BigNumber> {
    return calculateNativeTokenAmt(destChain, token, amount, walletAddress);
  }

  async maxSwapAmount(
    destChain: ChainName | ChainId,
    token: TokenId,
    walletAddress: string,
  ): Promise<BigNumber> {
    return calculateMaxSwapAmount(destChain, token, walletAddress);
  }

  async validate(
    token: TokenId | 'native',
    amount: string,
    sendingChain: ChainName | ChainId,
    senderAddress: string,
    recipientChain: ChainName | ChainId,
    recipientAddress: string,
    routeOptions: any,
  ): Promise<boolean> {
    throw new Error('not implemented');
  }

  async estimateSendGas(
    token: TokenId | 'native',
    amount: string,
    sendingChain: ChainName | ChainId,
    senderAddress: string,
    recipientChain: ChainName | ChainId,
    recipientAddress: string,
    routeOptions: RelayOptions,
  ): Promise<BigNumber> {
    const { relayerFee, toNativeToken } = routeOptions;
    const sendGas = await wh.estimateSendWithRelayGas(
      token,
      amount,
      sendingChain,
      senderAddress,
      recipientChain,
      recipientAddress,
      relayerFee,
      toNativeToken ? `${routeOptions.toNativeToken}` : '0',
    );
    if (!sendGas) throw new Error('could not estimate gas');
    return sendGas;
  }

  async estimateClaimGas(
    destChain: ChainName | ChainId,
    signedMessage?: SignedMessage,
  ): Promise<BigNumber> {
    if (!signedMessage)
      throw new Error('Cannot estimate gas without a signed message');
    throw new Error(
      'manual claim not implemented for automatic token bridge relays',
    );
  }

  /**
   * These operations have to be implemented in subclasses.
   */
  getMinSendAmount(routeOptions: any): number {
    const { relayerFee, toNativeToken } = routeOptions;

    // has to be slightly higher than the minimum or else tx will revert
    const fees = parseFloat(relayerFee) + parseFloat(toNativeToken);
    const min = (fees * 1.05).toFixed(6);
    return Number.parseFloat(min);
  }
  async send(
    token: TokenId | 'native',
    amount: string,
    sendingChain: ChainName | ChainId,
    senderAddress: string,
    recipientChain: ChainName | ChainId,
    recipientAddress: string,
    routeOptions: RelayOptions,
  ): Promise<string> {
    const fromChainId = wh.toChainId(sendingChain);
    const fromChainName = wh.toChainName(sendingChain);
    const decimals = getTokenDecimals(fromChainId, token);
    const parsedAmt = utils.parseUnits(amount, decimals);
    if (!wh.supportsSendWithRelay(fromChainId)) {
      throw new Error(`send with relay not supported`);
    }
    const parsedNativeAmt = routeOptions.toNativeToken
      ? utils
          .parseUnits(routeOptions.toNativeToken.toString(), decimals)
          .toString()
      : '0';
    const tx = await wh.sendWithRelay(
      token,
      parsedAmt.toString(),
      sendingChain,
      senderAddress,
      recipientChain,
      recipientAddress,
      parsedNativeAmt,
    );
    const txId = await signAndSendTransaction(
      fromChainName,
      tx,
      TransferWallet.SENDING,
    );
    wh.registerProviders();
    return txId;
  }

  async redeem(
    destChain: ChainName | ChainId,
    messageInfo: SignedMessage,
    payer: string,
  ): Promise<string> {
    // TODO: implement redeemRelay in the WormholeContext for self redemptions
    throw new Error('not implemented');
  }

  async getMessage(
    tx: string,
    chain: ChainName | ChainId,
  ): Promise<UnsignedMessage> {
    const message = await wh.getMessage(tx, chain);
    const parsed = (await adaptParsedMessage(message)) as ParsedRelayerMessage;
    if (parsed.payloadID !== PayloadType.Automatic) {
      throw new Error('wrong payload, not a token bridge relay transfer');
    }
    return {
      ...parsed,
      relayerFee: parsed.relayerFee.toString(),
      toNativeTokenAmount: parsed.toNativeTokenAmount.toString(),
    };
  }

  async getSignedMessage(
    message: RelayTransferMessage,
  ): Promise<SignedRelayTransferMessage> {
    const vaa = await fetchVaa(message);

    if (!vaa) {
      throw new Error('VAA not found');
    }

    return {
      ...message,
      vaa: utils.hexlify(vaa.bytes),
    };
  }

  async getPreview(
    token: TokenConfig,
    destToken: TokenConfig,
    amount: number,
    sendingChain: ChainName | ChainId,
    receipientChain: ChainName | ChainId,
    sendingGasEst: string,
    claimingGasEst: string,
    routeOptions: RelayOptions,
  ): Promise<TransferDisplayData> {
    const sendingChainName = wh.toChainName(sendingChain);
    const receipientChainName = wh.toChainName(receipientChain);
    const sourceGasToken = CHAINS[sendingChainName]?.gasToken;
    const destinationGasToken = CHAINS[receipientChainName]?.gasToken;
    const sourceGasTokenSymbol = sourceGasToken
      ? getDisplayName(TOKENS[sourceGasToken])
      : '';
    const destinationGasTokenSymbol = destinationGasToken
      ? getDisplayName(TOKENS[destinationGasToken])
      : '';
    const { relayerFee, receiveNativeAmt } = routeOptions;
    const isNative = token.key === sourceGasToken;

    let totalFeesText = '';
    if (sendingGasEst && relayerFee !== undefined) {
      const fee = toFixedDecimals(
        `${relayerFee + (isNative ? Number.parseFloat(sendingGasEst) : 0)}`,
        6,
      );
      totalFeesText = isNative
        ? `${fee} ${getDisplayName(token)}`
        : `${sendingGasEst} ${sourceGasTokenSymbol} & ${fee} ${getDisplayName(
            token,
          )}`;
    }

    const receiveAmt = await this.computeReceiveAmount(amount, routeOptions);

    const nativeGasDisplay =
      receiveNativeAmt > 0
        ? [
            {
              title: 'Native gas on destination',
              value: `${receiveNativeAmt} ${destinationGasTokenSymbol}`,
            },
          ]
        : [];

    return [
      {
        title: 'Amount',
        value: `${toFixedDecimals(`${receiveAmt}`, 6)} ${getDisplayName(
          destToken,
        )}`,
      },
      ...nativeGasDisplay,
      {
        title: 'Total fee estimates',
        value: totalFeesText,
        rows: [
          {
            title: 'Source chain gas estimate',
            value: sendingGasEst
              ? `~ ${sendingGasEst} ${sourceGasTokenSymbol}`
              : NO_INPUT,
          },
          {
            title: 'Relayer fee',
            value:
              relayerFee !== undefined
                ? `${relayerFee} ${getDisplayName(token)}`
                : NO_INPUT,
          },
        ],
      },
    ];
  }

  async getRelayerFee(
    sourceChain: ChainName | ChainId,
    destChain: ChainName | ChainId,
    token: string,
  ): Promise<BigNumber> {
    const context: any = wh.getContext(sourceChain);
    const tokenConfig = TOKENS[token];
    if (!tokenConfig) throw new Error('could not get token config');
    const tokenId = tokenConfig.tokenId || getWrappedTokenId(tokenConfig);
    return await context.getRelayerFee(sourceChain, destChain, tokenId);
  }

  async getTransferSourceInfo({
    txData: data,
  }: TransferInfoBaseParams): Promise<TransferDisplayData> {
    const txData = data as ParsedRelayerMessage;

    const formattedAmt = toNormalizedDecimals(
      txData.amount,
      txData.tokenDecimals,
      MAX_DECIMALS,
    );
    const { gasToken: sourceGasTokenKey } = CHAINS[txData.fromChain]!;
    const sourceGasToken = TOKENS[sourceGasTokenKey];
    const decimals = getTokenDecimals(
      toChainId(sourceGasToken.nativeChain),
      'native',
    );
    const formattedGas =
      txData.gasFee && toDecimals(txData.gasFee, decimals, MAX_DECIMALS);
    const token = TOKENS[txData.tokenKey];

    // automatic transfers
    const formattedFee = toNormalizedDecimals(
      txData.relayerFee,
      txData.tokenDecimals,
      MAX_DECIMALS,
    );
    const formattedToNative = toNormalizedDecimals(
      txData.toNativeTokenAmount,
      txData.tokenDecimals,
      MAX_DECIMALS,
    );
    const { gasToken } = CHAINS[txData.toChain]!;
    return [
      {
        title: 'Amount',
        value: `${formattedAmt} ${getDisplayName(token)}`,
      },
      {
        title: 'Gas fee',
        value: formattedGas
          ? `${formattedGas} ${getDisplayName(sourceGasToken)}`
          : NO_INPUT,
      },
      {
        title: 'Relayer fee',
        value: `${formattedFee} ${getDisplayName(token)}`,
      },
      {
        title: 'Convert to native gas token',
        value: `≈ ${formattedToNative} ${getDisplayName(
          token,
        )} \u2192 ${getDisplayName(TOKENS[gasToken])}`,
      },
    ];
  }

  async getTransferDestInfo({
    txData: data,
    receiveTx,
    transferComplete,
  }: TransferDestInfoParams): Promise<TransferDisplayData> {
    const txData: ParsedRelayerMessage = data as ParsedRelayerMessage;

    const token = TOKENS[txData.tokenKey];
    const { gasToken } = CHAINS[txData.toChain]!;

    // calculate the amount of native gas received
    let nativeGasAmt: string | undefined;
    const nativeGasToken = TOKENS[gasToken];
    if (receiveTx) {
      let nativeSwapAmount: any;
      try {
        nativeSwapAmount = await fetchSwapEvent(txData);
      } catch (e) {
        console.error(`could not fetch swap event:\n${e}`);
      }
      if (nativeSwapAmount) {
        const decimals = getTokenDecimals(
          wh.toChainId(txData.toChain),
          nativeGasToken.tokenId,
        );
        nativeGasAmt = toDecimals(nativeSwapAmount, decimals, MAX_DECIMALS);
      }
    }
    if (!nativeGasAmt) {
      // get the decimals on the target chain
      const destinationTokenDecimals = getTokenDecimals(
        wh.toChainId(txData.toChain),
        txData.tokenId,
      );
      const amount = await calculateNativeTokenAmt(
        txData.toChain,
        txData.tokenId,
        fromNormalizedDecimals(
          BigNumber.from(txData.toNativeTokenAmount),
          destinationTokenDecimals,
        ),
        txData.recipient,
      );
      // get the decimals on the target chain
      const nativeGasTokenDecimals = getTokenDecimals(
        wh.toChainId(txData.toChain),
        getWrappedTokenId(nativeGasToken),
      );
      nativeGasAmt = toDecimals(
        amount.toString(),
        // nativeGasToken.decimals,
        nativeGasTokenDecimals,
        MAX_DECIMALS,
      );
    }

    const receiveAmt = BigNumber.from(txData.amount)
      .sub(BigNumber.from(txData.relayerFee))
      .sub(BigNumber.from(txData.toNativeTokenAmount || 0));
    const formattedAmt = toNormalizedDecimals(
      receiveAmt,
      txData.tokenDecimals,
      MAX_DECIMALS,
    );

    return [
      {
        title: 'Amount',
        value: `${formattedAmt} ${getDisplayName(token)}`,
      },
      {
        title: 'Native gas token',
        value: nativeGasAmt
          ? `${nativeGasAmt} ${getDisplayName(TOKENS[gasToken])}`
          : NO_INPUT,
      },
    ];
  }
}

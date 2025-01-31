import React, { useEffect } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { makeStyles } from 'tss-react/mui';
import { BigNumber } from 'ethers';

import { RootState } from 'store';
import {
  setReceiverNativeBalance,
  setReceiveAmount,
  setDestToken,
  setToken,
  setSupportedSourceTokens,
  setSupportedDestTokens,
  setAllSupportedDestTokens,
  setTransferRoute,
  TransferInputState,
} from 'store/transferInput';
import { CHAINS, TOKENS, pageHeader } from 'config';
import { TokenConfig, Route } from 'config/types';
import { getTokenDecimals } from 'utils';
import { wh, toChainId } from 'utils/sdk';
import { joinClass } from 'utils/style';
import { toDecimals } from 'utils/balance';
import { isTransferValid, validate } from 'utils/transferValidation';
import RouteOperator from 'utils/routes/operator';

import GasSlider from './NativeGasSlider';
import Preview from './Preview';
import Send from './Send';
import { Collapse } from '@mui/material';
import PageHeader from 'components/PageHeader';
import FromInputs from './Inputs/From';
import ToInputs from './Inputs/To';
import TransferLimitedWarning from './TransferLimitedWarning';
import SwapChains from './SwapChains';
import RouteOptions from './RouteOptions';
import ValidationError from './ValidationError';

const useStyles = makeStyles()((theme) => ({
  spacer: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
  },
  bridgeContent: {
    margin: 'auto',
    maxWidth: '650px',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
  },
}));

function isSupportedToken(
  token: string,
  supportedTokens: TokenConfig[],
): boolean {
  if (!token) return true;
  return supportedTokens.some((t) => t.key === token);
}

function Bridge() {
  const { classes } = useStyles();
  const dispatch = useDispatch();
  const {
    validate: showValidationState,
    validations,
    fromChain,
    toChain,
    token,
    destToken,
    route,
    foreignAsset,
    associatedTokenAddress,
    isTransactionInProgress,
    amount,
    availableRoutes,
  }: TransferInputState = useSelector(
    (state: RootState) => state.transferInput,
  );
  const { toNativeToken, relayerFee } = useSelector(
    (state: RootState) => state.relay,
  );
  const { sending, receiving } = useSelector(
    (state: RootState) => state.wallet,
  );

  // check destination native balance
  useEffect(() => {
    if (!fromChain || !toChain || !receiving.address) return;
    const chainConfig = CHAINS[toChain]!;
    wh.getNativeBalance(receiving.address, toChain).then((res: BigNumber) => {
      const tokenConfig = TOKENS[chainConfig.gasToken];
      if (!tokenConfig)
        throw new Error('Could not get native gas token config');
      const decimals = getTokenDecimals(
        toChainId(tokenConfig.nativeChain),
        'native',
      );
      dispatch(setReceiverNativeBalance(toDecimals(res, decimals, 6)));
    });
  }, [fromChain, toChain, receiving.address, dispatch]);

  useEffect(() => {
    const computeSrcTokens = async () => {
      const supported = await RouteOperator.allSupportedSourceTokens(
        TOKENS[destToken],
        fromChain,
        toChain,
      );
      dispatch(setSupportedSourceTokens(supported));
      const selectedIsSupported = isSupportedToken(token, supported);
      if (!selectedIsSupported) {
        dispatch(setToken(''));
      }
      if (supported.length === 1 && token === '') {
        dispatch(setToken(supported[0].key));
      }
    };
    computeSrcTokens();
    // IMPORTANT: do not include token in dependency array
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, fromChain, destToken, dispatch]);

  useEffect(() => {
    const computeDestTokens = async () => {
      const supported = await RouteOperator.allSupportedDestTokens(
        TOKENS[token],
        fromChain,
        toChain,
      );
      dispatch(setSupportedDestTokens(supported));
      const allSupported = await RouteOperator.allSupportedDestTokens(
        undefined,
        fromChain,
        toChain,
      );
      dispatch(setAllSupportedDestTokens(allSupported));
      const selectedIsSupported = isSupportedToken(destToken, supported);
      if (!selectedIsSupported) {
        dispatch(setDestToken(''));
      }
      if (supported.length === 1 && destToken === '') {
        dispatch(setDestToken(supported[0].key));
      }

      // If all the supported tokens are the same token
      // select the native version
      const symbols = supported.map((t) => t.symbol);
      if (
        destToken === '' &&
        toChain &&
        symbols.every((s) => s === symbols[0])
      ) {
        const key = supported.find(
          (t) =>
            t.symbol === symbols[0] &&
            t.nativeChain === t.tokenId?.chain &&
            t.nativeChain === toChain,
        )?.key;
        if (key) {
          dispatch(setDestToken(key));
        }
      }
    };
    computeDestTokens();
    // IMPORTANT: do not include destToken in dependency array
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, token, fromChain, toChain, dispatch]);

  useEffect(() => {
    const establishRoute = async () => {
      if (!showValidationState || !availableRoutes) {
        dispatch(setTransferRoute(undefined));
        return;
      }
      const routeOrderOfPreference = [
        Route.CosmosGateway,
        Route.CCTPRelay,
        Route.CCTPManual,
        Route.Relay,
        Route.Bridge,
      ];
      for (const r of routeOrderOfPreference) {
        if (availableRoutes.includes(r)) {
          dispatch(setTransferRoute(r));
          return;
        }
      }
      dispatch(setTransferRoute(undefined));
    };
    establishRoute();
  }, [
    showValidationState,
    availableRoutes,
    fromChain,
    toChain,
    token,
    destToken,
    amount,
    dispatch,
  ]);

  useEffect(() => {
    const recomputeReceive = async () => {
      if (!route) return;
      const newReceiveAmount = await RouteOperator.computeReceiveAmount(
        route,
        Number.parseFloat(amount),
        { toNativeToken, relayerFee },
      );
      dispatch(setReceiveAmount(newReceiveAmount.toString()));
    };
    recomputeReceive();
  }, [amount, toNativeToken, relayerFee, route, dispatch]);

  // validate transfer inputs
  useEffect(() => {
    validate(dispatch);
  }, [
    sending,
    receiving,
    fromChain,
    toChain,
    token,
    destToken,
    route,
    toNativeToken,
    relayerFee,
    foreignAsset,
    associatedTokenAddress,
    dispatch,
  ]);
  const valid = isTransferValid(validations);
  const disabled = !valid || isTransactionInProgress;
  const showGasSlider =
    route && RouteOperator.getRoute(route).NATIVE_GAS_DROPOFF_SUPPORTED;

  return (
    <div className={joinClass([classes.bridgeContent, classes.spacer])}>
      <PageHeader title={pageHeader} />

      <FromInputs />
      <SwapChains />
      <ToInputs />

      <ValidationError validations={[validations.route]} margin="8px 0 0 0" />

      <Collapse in={valid && showValidationState}>
        <div className={classes.spacer}>
          <RouteOptions />

          <Collapse
            in={showGasSlider}
            sx={
              !showGasSlider
                ? { marginBottom: '-16px', transition: 'margin 0.4s' }
                : {}
            }
          >
            {showGasSlider && <GasSlider disabled={disabled} />}
          </Collapse>

          <Preview collapsed={!showValidationState ? true : !valid} />

          <TransferLimitedWarning />

          <Send valid={!!valid} />
        </div>
      </Collapse>
    </div>
  );
}

export default Bridge;

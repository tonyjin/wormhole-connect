import { deriveAddress } from '../../utils';
import { PublicKey, PublicKeyInitData } from '@solana/web3.js';

export interface SenderConfig {
  owner: PublicKey;
  bump: number;
  tokenBridge: any;
  relayerFeePrecision: number;
  paused: boolean;
}

export function deriveSenderConfigAddress(
  programId: PublicKeyInitData,
): PublicKey {
  return deriveAddress([Buffer.from('sender')], programId);
}

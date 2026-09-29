// Input schema helpers. Every input is a flag and never prompts, so agents and scripts get the same behaviour as a TTY.
import { InputFieldType, type InputField } from "@metamask/agent-wallet/plugin";

export const text = (flag: string, message: string, required = false): InputField => ({ type: InputFieldType.Text, flag, message, required, prompt: false });
export const bool = (flag: string, message: string): InputField => ({ type: InputFieldType.Boolean, flag, message, default: false, prompt: false });

export const addressInput = text("address", "Read this address instead of the selected Agent Wallet (read-only)");
export const slippageInput = text("slippage-bps", "Price tolerance in basis points (default from config, else 50 = 0.5%)");

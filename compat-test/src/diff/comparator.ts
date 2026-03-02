import { expect } from "vitest";
import { normalize, normalizeError } from "./normalizer.js";

export function compare(oracleResult: any, testResult: any) {
    const normOracle = normalize(oracleResult);
    const normTest = normalize(testResult);

    expect(normTest).toEqual(normOracle);
}

export function compareError(oracleError: any, testError: any) {
    const normOracleErr = normalizeError(oracleError);
    const normTestErr = normalizeError(testError);

    expect(normTestErr).toEqual(normOracleErr);
}

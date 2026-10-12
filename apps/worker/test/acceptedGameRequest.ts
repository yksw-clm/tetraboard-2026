import { legalVersion } from "@tetraboard/protocol/privacy";
// 既存の対局シナリオは、規約・年齢条件を確認した利用者をfixtureにします。
// 未同意の検証では、このfixtureを使わずRequestを直接作ります。
export class AcceptedGameRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set("X-Legal-Consent", legalVersion);
    super(input, { ...init, headers });
  }
}

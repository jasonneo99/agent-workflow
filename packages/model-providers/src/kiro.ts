import { BedrockProvider, defaultKiroModel, defaultKiroRegion } from "./bedrock.js";

export class KiroProvider extends BedrockProvider {
  constructor() {
    super({
      id: "kiro",
      model: defaultKiroModel(),
      region: defaultKiroRegion()
    });
  }
}

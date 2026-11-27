/**
 * Common adapter contract. Adapters receive normalized chat requests and return
 * normalized usage; provider-specific credentials and wire formats stay inside
 * implementations. Unknown outcomes must never be treated as retry-safe.
 */
export class ProviderAdapter {
  constructor(name){
    if(!name)throw new Error("Provider adapter name is required.");
    this.name=name;
  }
  async invoke(){throw new Error(`${this.name} does not implement invoke().`);}
  async *stream(){throw new Error(`${this.name} does not implement stream().`);}
  async reconcile(){return {kind:"unknown",message:`${this.name} cannot look up usage by request ID.`};}
}

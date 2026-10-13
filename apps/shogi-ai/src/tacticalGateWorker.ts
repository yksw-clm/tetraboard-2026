import { AiStore } from "./store";
import { passesTacticalGate } from "./tacticalGate";
const store = new AiStore(process.env.AI_DATA_DIR ?? ".shogi-ai");
const passed = passesTacticalGate(store.model(process.argv[2]));
store.close();
if (!passed) process.exit(1);

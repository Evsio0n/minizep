import { MemoryGraphStore } from '../src/store/memory-store.js';
import { runStoreConformance } from './store-conformance.js';

runStoreConformance('memory', async () => new MemoryGraphStore());

import { wikivoyageTransport } from "../lib/server/wikivoyage-guide";
import { eastChinaTripTransport } from "../lib/server/eastchinatrip-guide";
import { browserSearchTransport } from "../lib/server/browser-search";
import { xhsGuideSearchTransport } from "../lib/server/xhs-guide-search";
import { aiTransport } from '../lib/server/ai/provider';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Test processes must never read/write a person's saved AI profiles.
const directory=mkdtempSync(join(tmpdir(),'xhs-test-ai-'));
process.env.AI_CONFIG_DIR=directory;
process.env.PERSONAL_STYLES_DIR=join(directory,'personal-styles');
process.on('exit',()=>rmSync(directory,{recursive:true,force:true}));

// Existing business tests replace global fetch. Bridge those explicit mocks into
// the single provider transport; never permit an unmocked model request here.
// This test-only setup is not imported by application code.
const originalFetch=globalThis.fetch;
aiTransport.fetch=async(input,init)=>{
 if(globalThis.fetch===originalFetch)throw new Error('Test model transport must be mocked');
 return globalThis.fetch(input,init);
};

// Unit tests must explicitly mock the browser, never touch the owner's tabs.
browserSearchTransport.run = async () => { throw new Error("Test browser transport must be mocked"); };
xhsGuideSearchTransport.run = async () => { throw new Error("Test guide browser transport must be mocked"); };
wikivoyageTransport.run = async () => { throw new Error("Test guide browser transport must be mocked"); };
eastChinaTripTransport.run = async () => { throw new Error("Test guide browser transport must be mocked"); };

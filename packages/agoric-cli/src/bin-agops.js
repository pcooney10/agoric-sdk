#!/usr/bin/env node
/* eslint-disable @jessie.js/no-nested-await */
/* global process */

import '@agoric/casting/node-fetch-shim.js';
import '@endo/init';
import '@endo/init/pre.js';

import anylogger from 'anylogger';
import { Command } from 'commander';
import path from 'path';
import { makeOracleCommand } from './commands/oracle.js';
import { makeEconomicCommiteeCommand } from './commands/ec.js';
import { makePsmCommand } from './commands/psm.js';
import { makeReserveCommand } from './commands/reserve.js';
import { makeVaultsCommand } from './commands/vaults.js';
import { makePerfCommand } from './commands/perf.js';

const logger = anylogger('agops');
const progname = path.basename(process.argv[1]);

const program = new Command();
program.name(progname).version('unversioned');

program.addCommand(await makeOracleCommand(logger));
program.addCommand(await makeEconomicCommiteeCommand(logger));
program.addCommand(await makePerfCommand(logger));
program.addCommand(await makePsmCommand(logger));
program.addCommand(await makeReserveCommand(logger));
program.addCommand(await makeVaultsCommand(logger));

await program.parseAsync(process.argv);

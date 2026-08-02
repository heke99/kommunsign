import type { CaseRepository } from '../../ports.js';
import type { SqlDatabase } from '../../../../../packages/database/src/index.js';
import type { ProductionInfrastructure } from './infrastructure.js';
import { createCaseRepository } from './data-database.js';

export type DocumentRepository = Pick<
  CaseRepository,
  'addDocument' | 'signedDocument' | 'validationReport' | 'evidencePackage'
>;

export function createDocumentRepository(
  database: SqlDatabase,
  infrastructure: ProductionInfrastructure,
): DocumentRepository {
  const cases = createCaseRepository(database, infrastructure);
  return {
    addDocument: cases.addDocument.bind(cases),
    signedDocument: cases.signedDocument.bind(cases),
    validationReport: cases.validationReport.bind(cases),
    evidencePackage: cases.evidencePackage.bind(cases),
  };
}

// Salesforce integration stub.
// Replace with real jsforce OAuth + SOQL calls once SFDC credentials are wired.

import jsforce from 'jsforce';
import 'dotenv/config';

let connPromise = null;

async function getConnection() {
  if (connPromise) return connPromise;

  if (!process.env.SALESFORCE_CLIENT_ID) {
    // No SFDC configured — surface empty results so the cycle doesn't crash.
    return null;
  }

  const conn = new jsforce.Connection({
    oauth2: {
      clientId: process.env.SALESFORCE_CLIENT_ID,
      clientSecret: process.env.SALESFORCE_CLIENT_SECRET,
      redirectUri: process.env.SALESFORCE_REDIRECT_URI,
    },
  });

  // TODO: implement refresh-token flow. For now returning unauthenticated conn.
  connPromise = Promise.resolve(conn);
  return connPromise;
}

/**
 * Pull accounts that have not yet been researched by the SDR agent.
 * Expected shape per record:
 *   { sfdc_id, company, domain, contact_name, contact_title, contact_email, raw }
 */
export async function getPendingAccounts() {
  const conn = await getConnection();
  if (!conn) {
    console.warn('[salesforce] SFDC not configured — returning []');
    return [];
  }

  // TODO: replace with actual SOQL once schema is finalised.
  // Example:
  // const soql = `
  //   SELECT Id, Name, Website, (SELECT Id, Name, Title, Email FROM Contacts LIMIT 1)
  //   FROM Account
  //   WHERE Ambition_Researched__c = FALSE
  //   LIMIT 100
  // `;
  // const result = await conn.query(soql);
  // return result.records.map(mapAccount);

  return [];
}

export async function markAccountResearched(sfdcId) {
  const conn = await getConnection();
  if (!conn) return;
  // TODO: update Ambition_Researched__c flag on the SFDC Account record.
  void sfdcId;
}

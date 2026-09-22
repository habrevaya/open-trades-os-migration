/**
 * The GraphQL documents, kept apart from the adapter so they can be read as
 * documents rather than as strings embedded in control flow.
 *
 * Page size is 50 rather than the maximum. Jobber throttles on query COST, not
 * request count, and a nested connection multiplies: 100 jobs each pulling 20
 * visits is a 2,000-node query that burns the whole bucket in one call and
 * then stalls for a minute. Fifty keeps the extraction steady, and steady
 * finishes an overnight run that bursty does not.
 */

export const PAGE_SIZE = 50;

const PAGE_INFO = `pageInfo { hasNextPage endCursor }`;

export const ACCOUNT = `
  query Account { account { id name } }
`;

export const CLIENTS = `
  query Clients($first: Int!, $after: String) {
    clients(first: $first, after: $after) {
      ${PAGE_INFO}
      nodes {
        id isCompany companyName firstName lastName isArchived
        emails { address primary description }
        phones { number primary description }
        billingAddress { street1 street2 city province postalCode country }
        tags { label }
        customFields { ... on CustomFieldText { label valueText }
                       ... on CustomFieldNumeric { label valueNumeric }
                       ... on CustomFieldTrueFalse { label valueBoolean }
                       ... on CustomFieldLink { label valueLink { url text } } }
        createdAt updatedAt
      }
    }
  }
`;

export const PROPERTIES = `
  query Properties($first: Int!, $after: String) {
    properties(first: $first, after: $after) {
      ${PAGE_INFO}
      nodes {
        id name
        client { id }
        address { street1 street2 city province postalCode country latitude longitude }
        customFields { ... on CustomFieldText { label valueText }
                       ... on CustomFieldNumeric { label valueNumeric } }
      }
    }
  }
`;

/**
 * Visits are nested rather than fetched separately, because a visit is only
 * meaningful with its job and Jobber offers no top-level visit connection that
 * carries the job link cheaply. The nested page is capped at 100: a weekly
 * maintenance job running for two years has more than that, and the adapter
 * detects the truncation rather than silently importing the first hundred.
 */
export const JOBS = `
  query Jobs($first: Int!, $after: String) {
    jobs(first: $first, after: $after) {
      ${PAGE_INFO}
      nodes {
        id jobNumber title instructions jobStatus jobType source
        createdAt completedAt startAt endAt
        client { id }
        property { id }
        total
        visits(first: 100) {
          ${PAGE_INFO}
          totalCount
          nodes {
            id title startAt endAt completedAt visitStatus instructions
            assignedUsers { nodes { id name { full } } }
          }
        }
        customFields { ... on CustomFieldText { label valueText }
                       ... on CustomFieldNumeric { label valueNumeric } }
      }
    }
  }
`;

export const INVOICES = `
  query Invoices($first: Int!, $after: String) {
    invoices(first: $first, after: $after) {
      ${PAGE_INFO}
      nodes {
        id invoiceNumber subject invoiceStatus issuedDate dueDate createdAt
        client { id }
        jobs { nodes { id } }
        amounts { subtotal taxAmount discountAmount total invoiceBalance paymentsTotal }
        lineItems(first: 100) {
          ${PAGE_INFO}
          nodes { id name description quantity unitPrice totalPrice taxable
                  linkedProductOrService { id name } }
        }
      }
    }
  }
`;

export const QUOTES = `
  query Quotes($first: Int!, $after: String) {
    quotes(first: $first, after: $after) {
      ${PAGE_INFO}
      nodes {
        id quoteNumber title message quoteStatus createdAt transitionedAt
        client { id }
        property { id }
        amounts { subtotal taxAmount discountAmount total depositAmount }
        lineItems(first: 100) {
          ${PAGE_INFO}
          nodes { id name description quantity unitPrice totalPrice taxable }
        }
      }
    }
  }
`;

export const PAYMENTS = `
  query Payments($first: Int!, $after: String) {
    paymentRecords(first: $first, after: $after) {
      ${PAGE_INFO}
      nodes {
        id amount paymentType entryDate createdAt adjustmentType
        client { id }
        invoice { id }
      }
    }
  }
`;

export const PRODUCTS = `
  query Products($first: Int!, $after: String) {
    productsAndServices(first: $first, after: $after) {
      ${PAGE_INFO}
      nodes { id name description category defaultUnitCost internalUnitCost
              taxable durationMinutes onlineBookingsEnabled }
    }
  }
`;

export const USERS = `
  query Users($first: Int!, $after: String) {
    users(first: $first, after: $after) {
      ${PAGE_INFO}
      nodes { id name { first last full } email { raw } phone { raw } status isAccountAdmin }
    }
  }
`;

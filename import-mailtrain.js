const winston = require('winston');
const throat = require('throat');
const request = require('request-promise');

const MailTrainKey = process.env.MAILTRAIN_KEY;
const user = process.env.AUTH_USER;
const password = process.env.AUTH_PASSWORD;

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

const api = require('@fi/api-client');
const client = api.createClient({
  endpoint: process.env.API_ENDPOINT,
  clientId: user,
  clientSecret: password
});

winston.configure({
  level: LOG_LEVEL,
  transports: [
    new (winston.transports.Console)()
  ]
});

async function updatePerson(person) {
  let inscriptions = [];
  if (person && person.events && person.events.length > 0) {
    inscriptions.push('evenements');
  }
  else {
    inscriptions.push('sans_evenements');
  }
  if (person && person.groups && person.groups.length > 0) {
    inscriptions.push('groupe_appui');
  }
  else {
    inscriptions.push('sans_groupe_appui');
  }

  let action = person.email_opt_in === true ? 'subscribe' : 'unsubscribe';

  try {
    await request.post({
      url: `https://newsletter.jlm2017.fr/api/${action}/SyWda9pi?access_token=${MailTrainKey}`,
      body: {
        MERGE_TAGS: person.tags.join(','),
        EMAIL: person.email,
        MERGE_ZIPCODE: person.location.zip,
        MERGE_INSCRIPTIONS: inscriptions.join(',')
      },
      json: true
    });
  } catch (err) {
    winston.error(`Error updating ${person.email} on Mailtrain`, err.message);
  }
}

async function updateMailtrain(forever = true) {
  do {
    winston.profile('import_mailtrain');
    winston.info('cycle starting');

    let people = await client['people'].list();

    do {
      await Promise.all(people.map(throat(50, updatePerson)));
    } while(people.hasNext && (people = await people.getNext()));

    winston.profile('import_mailtrain');
  } while(forever);
}

updateMailtrain();

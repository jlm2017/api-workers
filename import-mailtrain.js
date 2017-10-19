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

const tagWhiteList = [
  'créateur groupe d\'appui',
  'convention : cars',
  'convention : inscrit',
  'groupe d\'appuis certifié',
];

function shouldIncludeTag(tag) {
  return tagWhiteList.includes(tag) || tag.startsWith('agir ');
}

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

  let primary_email_action = person.email_opt_in === true ? 'subscribe' : 'unsubscribe';

  await Promise.all(person.emails.map(async (email, index) => {
    if (email.bounced) {
      return;
    }

    try {
      await request.post({
        url: `https://newsletter.jlm2017.fr/api/${index ? 'unsubscribe' : primary_email_action}/SyWda9pi?access_token=${MailTrainKey}`,
        body: {
          MERGE_TAGS: person.tags.filter(shouldIncludeTag).join(','),
          EMAIL: email.address,
          FIRST_NAME: person.first_name,
          LAST_NAME: person.last_name,
          MERGE_ZIPCODE: person.location.zip,
          MERGE_INSCRIPTIONS: inscriptions.join(','),
          MERGE_API_UPDATED: new Date(),
          FORCE_SUBSCRIBE: 'yes'
        },
        json: true
      });
    } catch (err) {
      if (err.statusCode == 400) {
        person.emails[index].bounced = true;
        await person.save();
      }
      winston.error(`Error updating ${person.email} on Mailtrain`, err.message);
    }
  }));
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

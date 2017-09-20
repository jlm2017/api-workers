const request = require('request-promise');
const co = require('co');
const yn = require('yn');
const winston = require('winston');

const nb = require('./nation-builder');
const utils = require('./utils');

const api = require('@fi/api-client');


const NBAPIKey = process.env.NB_API_KEY_2;
const NBNationSlug = process.env.NB_SLUG;
const user = process.env.AUTH_USER;
const password = process.env.AUTH_PASSWORD;

const client = api.createClient({
  endpoint: process.env.API_ENDPOINT,
  clientId: user,
  clientSecret: password
});

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

winston.configure({
  level: LOG_LEVEL,
  transports: [
    new (winston.transports.Console)()
  ]
});


const importPeople = co.wrap(function *(forever = true) {
  do {
    winston.profile('import_people');

    winston.info('Starting new importing cycle');
    let fetchNextPage = nb.fetchAll(NBNationSlug, 'people', {NBAPIKey});
    while (fetchNextPage !== null) {
      let results;
      [results, fetchNextPage] = yield fetchNextPage();
      if (results) {
        for (let i = 0; i < results.length; i += 10) {
          yield results.slice(i, i + 10).map(updatePerson);
        }

        winston.debug('Handled page');
      }
    }
    winston.profile('import_people');
  } while (forever);
});


const updatePerson = co.wrap(function *(nbPerson) {
  if (!nbPerson.email) return;

  yield updatePersonInAPI(nbPerson);
});


const updatePersonInAPI = co.wrap(function*(nbPerson) {

  let props = {
    first_name: nbPerson.first_name,
    last_name: nbPerson.last_name,
    email: nbPerson.email,
    email_opt_in: nbPerson.email_opt_in,
    id: nbPerson.id,
    tags: nbPerson.tags
  };
  if (nbPerson && nbPerson.primary_address) {
    props.location = {
      address: nbPerson.primary_address.address1 + ', ' + nbPerson.primary_address.zip + ' ' + nbPerson.primary_address.city,
      address1: nbPerson.primary_address.address1,
      address2: nbPerson.primary_address.address2,
      city: nbPerson.primary_address.city,
      country_code: nbPerson.primary_address.country_code,
      zip: nbPerson.primary_address.zip,
      state: nbPerson.primary_address.state
    };
  }

  let person;
  // Does the person already exist in the API ?
  try {
    person = yield client.people.getById(nbPerson.id);
  } catch (err) {
    person = null;
    if (!(err instanceof api.exceptions.NotFoundError)) {
      winston.error(`Failed fetching person ${nbPerson.id}`, {nbId: nbPerson.id, message: err.message});
      return null;
    }
  }

  if (person === null) {
    // If the person did not exist, insert it
    try {
      person = client.people.create(props);
      yield person.save();
    } catch (err) {
      winston.error(`Error while creating ${nbPerson.email}:`, err.message, err.meta.text);
    }
  } else {
    // If she did exist, patch it... but only if there's a change!
    if (utils.anyPropChanged(person, props)) {
      winston.debug(`Patching people/${person._id}`);
      try {
        Object.assign(person, props);
        yield person.save();
      } catch (err) {
        winston.error(`Error while patching ${nbPerson.email}`, {nbId: nbPerson.id, person, message: err.message});
      }
    } else {
      winston.debug(`Nothing changed with people/${person._id}`);
    }
  }

  return person;
});

module.exports = {importPeople, updatePerson};

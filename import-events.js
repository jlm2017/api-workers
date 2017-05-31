'use strict';

const co = require('co');
const winston = require('winston');

const nb = require('./lib/nation-builder');
const utils = require('./lib/utils');

const api = require('@fi/api-client');

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

winston.configure({
  level: LOG_LEVEL,
  transports: [
    new (winston.transports.Console)()
  ]
});

const NBAPIKey = process.env.NB_API_KEY_1;
const NBNationSlug = process.env.NB_SLUG;
const user = process.env.AUTH_USER;
const password = process.env.AUTH_PASSWORD;

const client = api.createClient({
  endpoint: process.env.API_ENDPOINT,
  clientId: user,
  clientSecret: password
});


const importEvents = co.wrap(function *(forever = true) {
  do {
    winston.profile('import_events');

    winston.info('Starting new import_events cycle');
    let fetchNextPage = nb.fetchAll(NBNationSlug, `sites/${NBNationSlug}/pages/events`, {NBAPIKey});
    while (fetchNextPage !== null) {
      let results;
      [results, fetchNextPage] = yield fetchNextPage();

      if (results) {
        for (let i = 0; i < results.length; i += 10) {
          yield results.slice(i, i + 10).map(updateEvent);
        }
      }
    }

    winston.profile('import_events');
  } while (forever);
});

/**
 * Update event
 * @type {[type]}
 */
const updateEvent = co.wrap(function *(nbEvent) {
  winston.debug('Update event:' + nbEvent.id);

  // Which resource are we using on api.jlm2017.fr
  const resource = nbEvent.calendar_id === 3 ? 'groups' : 'events';

  // Construct our POST body
  const props = {
    id: nbEvent.id,
    name: nbEvent.name,
    path: nbEvent.path,
    tags: nbEvent.tags,
    published: (nbEvent.status.indexOf('publiée') !== -1),
    contact: {
      name: nbEvent.contact.name
    }
  };

  if (nbEvent.intro) {
    props.description = nbEvent.intro;
  }

  if (nbEvent.contact.show_phone && nbEvent.contact.phone) {
    props.contact.phone = nbEvent.contact.phone;
  }

  if (nbEvent.contact.show_email && nbEvent.contact.email) {
    props.contact.email = nbEvent.contact.email;
  }

  if (nbEvent.venue && nbEvent.venue.address && nbEvent.venue.address.lng &&
    nbEvent.venue.address.lat) {
    props.coordinates = {
      type: 'Point',
      coordinates: [
        Number(nbEvent.venue.address.lng),
        Number(nbEvent.venue.address.lat)
      ]
    };
    props.location = {
      name: nbEvent.venue.name || '',
      address: nbEvent.venue.address.address1 + ', ' + nbEvent.venue.address.zip + ' ' + nbEvent.venue.address.city,
      address1: nbEvent.venue.address.address1 || '',
      address2: nbEvent.venue.address.address2 || '',
      city: nbEvent.venue.address.city || '',
      country_code: nbEvent.venue.address.country_code,
      zip: nbEvent.venue.address.zip || '',
      state: nbEvent.venue.address.state || ''
    };
  }

  if (nbEvent.calendar_id !== 3) {
    /* Seulement pour ce qui n'est pas un group d'appui !! */
    props.start_time = new Date(nbEvent.start_time).toISOString();
    props.end_time = new Date(nbEvent.end_time).toISOString();
    switch (nbEvent.calendar_id) {
    case 4:
      props.calendar = 'evenements_locaux';
      break;
    case 7:
      props.calendar = 'melenchon';
      break;
    case 15:
      props.calendar = 'reunions_circonscription';
      break;
    case 16:
      props.calendar = 'reunions_publiques';
      break;
    case 17:
      props.calendar = 'camion_melenchon';
      break;
    case 10:
      // ==> covoiturages
      return;
    case 14:
      // ==> hebergement
      return;
    default:
      // unknown calendar_id: let's log and return
      winston.info(`Event ${nbEvent.id}'s calendar_id is an unknown value (${nbEvent.calendar_id})`);
      return;
      // break;
    }
  }

  let event = null;
  try {
    // Does the event already exist in the API ?
    event = yield client[resource].getById(nbEvent.id);
  } catch (err) {
    if (!(err instanceof api.exceptions.NotFoundError)) {
      winston.error(`Failed fetching ${resource}/${nbEvent.id}`, {nbId: nbEvent.id, message: err.message});
      return;
    }
  }

  if (event === null) {
    // the event did not exist in the API before
    // we need to push it
    try {
      event = client[resource].create(props);
      yield event.save();
    } catch (err) {
      if (err instanceof api.exceptions.ValidationError) {
        yield checkValidationError(resource, props, err);
      } else {
        winston.error(`Error while creating ${resource} ${nbEvent.id}:`, err.message);
      }
    }
  } else {
    //the event did exist, we need to patch it, if it changed
    if (utils.anyPropChanged(event, props)) {
      winston.debug(`Patching ${resource}/${event._id}`);
      try {
        Object.assign(event, props);
        yield event.save();
      } catch (err) {
        winston.error(`Error while patching ${resource}/${event._id}`, {
          nbId: nbEvent.id,
          event,
          message: err.message
        });
      }
    } else {
      winston.debug(`Nothing changed with people/${event._id}`);
    }
  }
});


const checkValidationError = co.wrap(function*(resource, duplicate, originalError) {
  let duplicated;
  try {
    duplicated = yield client[resource].list({path: duplicate.path});
  } catch (err) {
    winston.error(
      'import-events - unknown error while checking duplicate',
      {resource, duplicate, originalError: originalError.message, error: err.message}
    );
    return;
  }
  if (!duplicated.length) {
    winston.error(
      'import-events - other validation error',
      {resource, id: duplicate.id, path: duplicate.path, error: originalError.message}
    );
    return;
  }

  let existing = duplicated[0];
  let differences = utils.getDifferentProps(existing, duplicate);
  delete differences.id;

  if (existing.id === duplicate.id) {
    winston.warn(
      'import-events - potential corner case',
      {duplicate: duplicate, existing: existing.id, path: duplicate.path, _id: existing._id, message: originalError.message}
    );
  } else {
    if (Object.keys(differences).length === 0) {
      winston.debug('import-events - exact duplicate', {duplicate: duplicate.id, existing: existing.id, _id: existing._id});
    } else {
      winston.info('import-events - partial duplicate',
        {duplicate: duplicate.id, existing: existing.id, _id: existing._id, differences});
    }
  }

});


importEvents();

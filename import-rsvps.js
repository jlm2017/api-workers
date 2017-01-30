'use strict';

const co = require('co');
const base64 = require('js-base64').Base64;
const delay = require('timeout-as-promise');
const request = require('request-promise');

const NBAPIKey = process.env.NB_API_KEY;
const NBNationSlug = process.env.NB_SLUG;
const APIKey = process.env.API_KEY;

var throttle = co.wrap(function * (res) {
  if (res.headers['x-ratelimit-remaining'] < 10) {
    var delayTime = res.headers['x-ratelimit-reset'] * 1000 -
      (new Date(res.headers.expires).getTime());
    console.log('Pause during ' + delayTime);
    yield delay(delayTime);
    console.log('Pause end.');
  }
});

/**
 * Update RSVP
 */
var updateRSVP = co.wrap(function * (resource, eventId, personId) {
  // Get email from te person nationbuilder id
  var r;
  try {
    r = yield request.get({
      url: `http://localhost:5000/people/${personId}`,
      headers: {
        Authorization: 'Basic ' + base64.encode(`${APIKey}:`)
      },
      json: true,
      resolveWithFullResponse: true
    });
  } catch (err) {
    console.error(`Error while fetching person ${personId} email:`, err.message);
    return;
  }

  var email = r.body.email;
  if (!email) {
    return;
  }

  var body = {};
  body[resource] = r.body.events ? [...new Set(r.body.events.concat(eventId))] : [eventId];

  try {
    yield request.patch({
      url: `http://localhost:5000/people/${r.body._id}`,
      body: body,
      headers: {
        'If-Match': r.body._etag,
        'Authorization': 'Basic ' + base64.encode(`${APIKey}:`)
      },
      json: true
    });
  } catch (err) {
    console.error(`Error while updating person ${personId} rsvps:`, err.message);
  }
});

/**
 * Get RSVPS
 */
var getRSVPS = co.wrap(function * (resource, item) {
  // Update RSVPs
  try {
    var res = yield request.get({
      url: `https://${NBNationSlug}.nationbuilder.com/api/v1/sites/${NBNationSlug}/pages/events/${item.id}/rsvps?limit=100&access_token=${NBAPIKey}`,
      json: true,
      resolveWithFullResponse: true
    });

    yield throttle(res);

    for (var i = 0; i < res.body.results.length; i++) {
      yield updateRSVP(resource, item._id, res.body.results[i].person_id);
    }
    try {
      item.participants = i;
      yield request.put({
        url: `http://localhost:5000/${resource}/${item._id}`,
        body: item,
        headers: {
          'If-Match': item._etag,
          'Authorization': 'Basic ' + base64.encode(`${APIKey}:`)
        },
        json: true
      });
    } catch (e) {
      if (e.statusCode === 404) { // The event does not exists
        console.error(`Error while updating event ${item.id}: it doesn't exist yet in the data base`);
      }
      console.error(`Error while updating event ${item.id}:`, e.message);
    }
  } catch (err) {
    console.error(`Error while fetching event ${item.id} rsvps:`, err.message);
  }
});

/**
 * Fetch events
 */
var fetchEvents = co.wrap(function * (resource) {
  try {
    var res = yield request({
      url: `http://localhost:5000/${resource}`,
      headers: {Accept: 'application/json'},
      json: true,
      resolveWithFullResponse: true
    });

    console.log(`Fetched all ${resource}.`);

    for (var i = 0; i < res.body._items.length; i += 10) {
      yield res.body._items.slice(i, i + 10).map(item => {
        try {
          return getRSVPS(resource, item);
        } catch (err) {
          console.log(`Error while updating event ${item.id}:`, err.message);
        }

        return Promise.resolve();
      });
    }

    console.log(`Updated ${i} persons.`);
  } catch (e) {
    console.log(e.message);
  } finally {
    fetchEvents(resource === 'events' ? 'groups' : 'events');
  }
});

fetchEvents('events');

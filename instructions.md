# Helpdesk Ticketing System

This code challenge is about implementing a Helpdesk ticketing system, where users can create, edit and delete tickets for IT to solve.

## Main tasks:

1. Create a Database of your preference to manage tickets (unique ticket number, title, description, user, status, comments...)
2. Write a REST API using Node.js that has enough endpoints to allow to:

- Get the list of all tickets
- Get a specific ticket
- Create a new ticket
- Update a specific ticket
- Delete a specific ticket

3. On the "Get the list of all tickets" service, add functionality to allow for filtering/sorting/paging the list of tickets.
4. Develop a React app Front-end solution that allows users to

- Display an initial list with all tickets, allowing Filtering/sorting/paging.
- When a ticket from the list is clicked, it should render a ticket detail view on a separate page displaying the the specific information of that ticket
- Create a new ticket
- Delete a specific ticket
- Update a ticket
- Make it look decent. No need for super sophisticated design, but at a minimum, make it responsive so that it looks good on a mobile phone.
- No users management and authentication is needed.

5. Push the code to a private github repo with a README.md that explains how to run API & Frontend app

## Bonus points

1. Generate documentation for the API.
2. Error handling.
3. Dockerize the app.
4. Write realistic tests.
5. Use of Typescript.

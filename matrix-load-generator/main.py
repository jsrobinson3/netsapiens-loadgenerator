import os
import asyncio
import random
import logging
import csv
from faker import Faker
from dotenv import load_dotenv
from nio import AsyncClient, LoginResponse, RoomCreateResponse, RoomVisibility
import concurrent.futures


# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s"
)


class MatrixUser:
    def __init__(
        self, full_user_id: str, password: str
    ):
        self.full_user_id = full_user_id
        self.password = password
        # Extract homeserver from full_user_id (format: @username:homeserver)
        self.homeserver = full_user_id.split(":")[-1]
        self.client = AsyncClient(f"https://{self.homeserver}", self.full_user_id)

    async def login(self):
        logging.info(f"Logging in: {self.full_user_id}")
        response = await self.client.login(self.password)
        if isinstance(response, LoginResponse):
            logging.info(f"Logged in successfully: {self.full_user_id}")
        else:
            raise Exception(f"Login failed for {self.full_user_id}: {response}")

    async def close(self):
        await self.client.close()


class MatrixMessenger:

    def __init__(self, users):
        self.users = users
        self.total_messages = int(os.getenv("MAX_MESSAGES", "300"))
        self.fake = Faker()
        self.use_threading = os.getenv("USE_THREADING", "false").lower() == "true"

    def generate_random_message(self):
        # Randomly choose number of sentences (1–5), each with variable length
        num_sentences = random.randint(1, 5)
        sentences = [self.fake.sentence(nb_words=random.randint(4, 12)) for _ in range(num_sentences)]
        return " ".join(sentences)
    
    def generate_group_name(self):
        # Create a realistic group name using a combination of words
        adjectives = ["Dynamic", "Brilliant", "Midnight", "Silent", "Crimson", "Quantum", "Rapid"]
        nouns = ["Coders", "Squad", "Crew", "Team", "Network", "Hackers", "Wizards", "Champions"]
        return f"{random.choice(adjectives)} {random.choice(nouns)}"

    async def create_dm_if_not_exists(self, client1: MatrixUser, client2: MatrixUser):
        await client1.client.sync(timeout=3000)

        # Check for existing DM
        for room_id, room in client1.client.rooms.items():
            if set(room.users.keys()) == {client1.full_user_id, client2.full_user_id}:
                logging.info(
                    f"DM already exists between {client1.full_user_id} and {client2.full_user_id}"
                )
                return room_id

        # Create new DM room
        response = await client1.client.room_create(
            is_direct=True,
            invite=[client2.full_user_id],
            visibility=RoomVisibility.private,
            room_type="DirectMessage",
            name="",  # optional
        )

        if not isinstance(response, RoomCreateResponse):
            raise Exception(f"Failed to create DM room: {response}")

        return response.room_id
    
    async def create_group_room(self, creator: MatrixUser, invitees: list[str]):
        group_name = self.generate_group_name()
        logging.info(f"Creating group chat: {group_name}")
        response = await creator.client.room_create(
            is_direct=False,
            invite=invitees,
            visibility=RoomVisibility.private,
            room_type="Groups",
            name=group_name,
        )
        if not isinstance(response, RoomCreateResponse):
            raise Exception(f"Failed to create group room: {response}")
        logging.info(f"Group chat room created: {response.room_id}")
        return response.room_id

    async def send_alternating_messages(
        self, client1: MatrixUser, client2: MatrixUser, room_id: str, total=300
    ):
        for i in range(total):
            sender = client1 if i % 2 == 0 else client2
            msg = self.generate_random_message()
            await sender.client.room_send(
                room_id,
                message_type="m.room.message",
                content={"msgtype": "m.text", "body": msg},
            )
            logging.info(f"[{sender.full_user_id}] Sent: {msg}")
            await asyncio.sleep(0.1)

    async def send_group_messages(self, room_id: str, users: list[MatrixUser], total: int):
        for i in range(total):
            sender = users[i % len(users)]
            msg = self.generate_random_message()
            await sender.client.room_send(
                room_id,
                message_type="m.room.message",
                content={"msgtype": "m.text", "body": msg},
            )
            logging.info(f"[{sender.full_user_id}] Sent to group: {msg}")
            await asyncio.sleep(0.1)

    async def run_dm_pair(self, user1: MatrixUser, user2: MatrixUser):
        logging.info(f"Initiating conversation between {user1.full_user_id} and {user2.full_user_id}")
        room_id = await self.create_dm_if_not_exists(user1, user2)
        await self.send_alternating_messages(user1, user2, room_id, self.total_messages)

    async def run_in_threads(self, tasks):
        loop = asyncio.get_running_loop()

        def runner(pair):
            user1, user2 = pair
            asyncio.run(self.run_dm_pair(user1, user2))

        with concurrent.futures.ThreadPoolExecutor() as executor:
            futures = [
                loop.run_in_executor(executor, runner, pair)
                for pair in tasks
            ]
            await asyncio.gather(*futures)

    async def run(self):
        await asyncio.gather(*(user.login() for user in self.users))

        tasks = []
        for i, user1 in enumerate(self.users):
            for j, user2 in enumerate(self.users):
                if i >= j:
                    continue
                if self.use_threading:
                    tasks.append(self.run_dm_pair(user1, user2))
                else:
                    await self.run_dm_pair(user1, user2)

        if self.use_threading:
            await asyncio.gather(*tasks)

        # Group chat (if applicable)
        if len(self.users) > 2:
            creator = self.users[0]
            invitees = [u.full_user_id for u in self.users[1:]]
            room_id = await self.create_group_room(creator, invitees)
            await self.send_group_messages(room_id, self.users, self.total_messages)

        await asyncio.gather(*(user.close() for user in self.users))


def load_users_from_csv(csv_path='users.csv'):
    """Load Matrix users from a CSV file with 'full_user_id' and 'password' columns."""
    
    if not os.path.exists(csv_path):
        raise FileNotFoundError(f"CSV file not found: {csv_path}")
    
    users = []
    with open(csv_path, 'r') as file:
        reader = csv.DictReader(file)
        if not {'full_user_id', 'password'}.issubset(set(reader.fieldnames)):
            raise ValueError("CSV file must contain 'full_user_id' and 'password' columns")
            
        for row in reader:
            users.append(MatrixUser(row['full_user_id'], row['password']))
    
    if not users:
        raise ValueError("No users found in the CSV file")
            
    return users


if __name__ == "__main__":
    import sys
    
    # Default CSV path is 'sample_users.csv' in the same directory, but can be provided as a command-line argument
    csv_path = sys.argv[1] if len(sys.argv) > 1 else 'sample_users.csv'
    
    users = load_users_from_csv(csv_path)
    messenger = MatrixMessenger(users)
    asyncio.run(messenger.run())

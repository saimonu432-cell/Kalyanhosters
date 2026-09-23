FROM node:20-bookworm

# Install Python 3 & pip
RUN apt-get update && apt-get install -y python3 python3-pip python3-full

WORKDIR /app

# Install Node modules
COPY package*.json ./
RUN npm install

# Install Python requirements
COPY requirements.txt ./
RUN pip install --break-system-packages -r requirements.txt || pip install -r requirements.txt

# Copy remaining project files
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]


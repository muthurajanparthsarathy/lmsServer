const express = require("express");

const app = express();

app.get("/leetcode/:username", async (req, res) => {

const query = `
query problemsetQuestionList {
  problemsetQuestionList: questionList(
    categorySlug: ""
    limit: 50
    skip: 0
    filters: {}
  ) {
    total: totalNum
    questions: data {
      questionId
      title
      titleSlug
      difficulty
      acRate
      topicTags {
        name
      }
    }
  }
}
`;

fetch("https://leetcode.com/graphql", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0"
  },
  body: JSON.stringify({ query })
})
.then(res => res.json())
.then(data => console.log(data));

  try {

    const response = await fetch("https://leetcode.com/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0"
      },
      body: JSON.stringify({
        query,
        variables: {
          username: req.params.username
        }
      })
    });

    const data = await response.json();

    res.json(data);

  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

app.listen(3001, () => {
  console.log("Server running");
});